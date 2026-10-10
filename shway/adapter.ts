// Thin browser boundary over FilmCraft's authoritative Rust project and proposal commands.
// Edit times cross this boundary only as safe integer ticks or integer frame deltas.
import {parseTranscript, TranscriptError} from "./takes.ts";
import type {SourceTranscript, TranscriptInput} from "./takes.ts";
export interface FilmcraftTransport {
  commands(): Promise<unknown>;
  execute(command: string, params?: Record<string, unknown>): Promise<unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export type ProposalToken = number;
export interface TrimStep {
  command: "timeline.trim";
  params: {clip: number; source: number; edge: "in" | "out"; mode: "regular" | "ripple"; deltaFrames: number};
}
export interface ReplaceStep {
  command: "clip.replaceFromBin";
  params: {clips: number[]; item: number; keepSourceIn?: boolean};
}
export interface EditProposal {
  expectedRevision: number;
  sequence: number;
  label: string;
  steps: (TrimStep | ReplaceStep)[];
}
export interface ProjectInspection {
  revision: number;
  activeSequence: number | null;
  [field: string]: unknown;
}
export interface ClipInspection {
  clip: number;
  item: number;
  start: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  [field: string]: unknown;
}
export interface TrackInspection {
  id: number;
  items: ClipInspection[];
  [field: string]: unknown;
}
export interface SequenceInspection {
  id: number;
  duration: number;
  video: TrackInspection[];
  audio: TrackInspection[];
  [field: string]: unknown;
}
export interface ProposalPreview {
  token: ProposalToken;
  expectedRevision: number;
  label: string;
  sequence: SequenceInspection;
  results: unknown[];
}
export interface ExportJob {
  id: number;
  finished: boolean;
  result: unknown;
  [field: string]: unknown;
}

const REQUIRED = [
  "project.inspect", "sequence.inspect", "timeline.select", "playhead.set", "edit.undo",
  "file.exportMedia", "jobs.list", "proposal.preview", "proposal.inspect", "proposal.cancel",
  "proposal.commit", "proposal.render",
] as const;

export class AdapterError extends Error {
  readonly code: "invalid" | "capability" | "stale" | "response";
  constructor(code: AdapterError["code"], message: string) {super(message); this.name = "AdapterError"; this.code = code;}
}

function invalid(message: string): never {throw new AdapterError("invalid", message);}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${name}: unsupported field ${key}`);
}
function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid(`${name} must be a safe integer >= ${minimum}`);
  return value;
}
function token(value: unknown): ProposalToken {
  return integer(value, "token", 1);
}
function label(value: unknown): string {
  // Bound UTF-16 length before trimming/encoding so hostile strings cannot size allocations.
  if (typeof value !== "string" || value.length === 0 || value.length > 120 || !value.trim() || new TextEncoder().encode(value).length > 120) invalid("label requires 1–120 UTF-8 bytes");
  return value;
}
function idList(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) invalid(`${name} requires 1–32 IDs`);
  const ids = Array.from(value, (id, i) => integer(id, `${name}[${i}]`, 1));
  if (new Set(ids).size !== ids.length) invalid(`${name} contains duplicate IDs`);
  return ids;
}
function sequenceResult(value: unknown): SequenceInspection {
  const sequence = object(value, "sequence response");
  integer(sequence.id, "sequence.id", 1); integer(sequence.duration, "sequence.duration");
  for (const kind of ["video", "audio"]) {
    const tracks = sequence[kind];
    if (!Array.isArray(tracks)) throw new AdapterError("response", `sequence.${kind} must be tracks`);
    for (const value of tracks) {
      const track = object(value, "track response"); integer(track.id, "track.id", 1);
      if (!Array.isArray(track.items)) throw new AdapterError("response", "track.items must be clips");
      for (const value of track.items) {
        const clip = object(value, "clip response");
        integer(clip.clip, "clip.clip", 1); integer(clip.item, "clip.item", 1);
        for (const field of ["start", "duration", "sourceIn", "sourceOut"]) integer(clip[field], `clip.${field}`);
      }
    }
  }
  return sequence as unknown as SequenceInspection;
}

// Copy and validate the complete proposal before awaiting transport: caller mutation cannot
// change a checked proposal while project/context discovery is in flight.
function proposalInput(value: EditProposal): EditProposal {
  const input = object(value, "proposal");
  keys(input, ["expectedRevision", "sequence", "label", "steps"], "proposal");
  const expectedRevision = integer(input.expectedRevision, "expectedRevision", 1);
  const sequence = integer(input.sequence, "sequence", 1);
  const checkedLabel = label(input.label);
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 16) invalid("proposal requires 1–16 steps");
  let targets = 0;
  const steps = Array.from(input.steps, (value, i): TrimStep | ReplaceStep => {
    const step = object(value, `steps[${i}]`); keys(step, ["command", "params"], `steps[${i}]`);
    const params = object(step.params, `steps[${i}].params`);
    if (step.command === "timeline.trim") {
      keys(params, ["clip", "source", "edge", "mode", "deltaFrames"], "trim");
      const clip = integer(params.clip, "clip", 1), source = integer(params.source, "source", 1);
      if (params.edge !== "in" && params.edge !== "out") invalid("trim edge must be in or out");
      if (params.mode !== "regular" && params.mode !== "ripple") invalid("trim mode must be regular or ripple");
      const deltaFrames = integer(params.deltaFrames, "deltaFrames", -Number.MAX_SAFE_INTEGER);
      if (deltaFrames === 0) invalid("trim deltaFrames must change the range");
      targets++;
      return {command: step.command, params: {clip, source, edge: params.edge, mode: params.mode, deltaFrames}};
    }
    if (step.command === "clip.replaceFromBin") {
      keys(params, ["clips", "item", "keepSourceIn"], "replacement");
      const clips = idList(params.clips, "clips"), item = integer(params.item, "item", 1);
      if (params.keepSourceIn !== undefined && typeof params.keepSourceIn !== "boolean") invalid("keepSourceIn must be boolean");
      targets += clips.length;
      return {command: step.command, params: {clips, item, ...(params.keepSourceIn === undefined ? {} : {keepSourceIn: params.keepSourceIn})}};
    }
    return invalid(`Unsupported proposal command: ${String(step.command)}`);
  });
  if (targets > 32) invalid("proposal exceeds 32 targets");
  return {expectedRevision, sequence, label: checkedLabel, steps};
}

// Find a media item's type and duration in project.inspect's bin tree (bounded walk).
function binItem(root: unknown, item: number): {type: unknown; duration: unknown} | null {
  const stack: unknown[] = [root];
  for (let visited = 0; stack.length && visited < 100_000; visited++) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const entry = node as Record<string, unknown>;
    if (entry.item === item) return {type: entry.type, duration: entry.duration};
    if (Array.isArray(entry.children)) stack.push(...entry.children.slice(0, 100_000));
  }
  return null;
}

export class ShwayAdapter {
  #transport: FilmcraftTransport;
  #capabilities: Set<string>;
  private constructor(transport: FilmcraftTransport, capabilities: Set<string>) {this.#transport = transport; this.#capabilities = capabilities;}

  static async connect(transport: FilmcraftTransport): Promise<ShwayAdapter> {
    if (!transport || typeof transport.commands !== "function" || typeof transport.execute !== "function" || typeof transport.request !== "function") invalid("A running window.filmcraft transport is required");
    const list = await transport.commands();
    if (!Array.isArray(list) || list.some(command => typeof command?.id !== "string")) throw new AdapterError("response", "filmcraft.commands() must return command IDs");
    const capabilities = new Set<string>(list.map(command => command.id));
    const missing = REQUIRED.filter(id => !capabilities.has(id));
    if (missing.length) throw new AdapterError("capability", `FilmCraft is missing required commands: ${missing.join(", ")}`);
    return new ShwayAdapter(transport, capabilities);
  }

  #execute(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.#capabilities.has(command)) throw new AdapterError("capability", `FilmCraft does not support ${command}`);
    return this.#transport.execute(command, params);
  }

  async #inspectProject(): Promise<ProjectInspection> {
    const project = object(await this.#execute("project.inspect"), "project response");
    integer(project.revision, "project.revision");
    if (project.activeSequence !== null) integer(project.activeSequence, "project.activeSequence", 1);
    return project as unknown as ProjectInspection;
  }

  async #inspectSequence(sequence?: number): Promise<SequenceInspection> {
    return sequenceResult(await this.#execute("sequence.inspect", sequence === undefined ? {} : {item: integer(sequence, "sequence", 1)}));
  }

  async inspect(): Promise<{project: ProjectInspection; sequence: SequenceInspection | null}> {
    const project = await this.#inspectProject();
    const sequence = project.activeSequence === null ? null : await this.#inspectSequence(project.activeSequence);
    const latest = await this.#inspectProject();
    if (latest.revision !== project.revision || latest.activeSequence !== project.activeSequence) throw new AdapterError("stale", "Project changed during inspection; inspect again");
    return {project, sequence};
  }

  async select(clips: number[]): Promise<unknown> {
    const checked = idList(clips, "clips");
    const sequence = await this.#inspectSequence();
    const known = new Set([...sequence.video, ...sequence.audio].flatMap(track => track.items.map(clip => clip.clip)));
    if (checked.some(id => !known.has(id))) invalid("Selection references a clip outside the active sequence");
    return this.#execute("timeline.select", {clips: checked, add: false, toggle: false});
  }

  play(): Promise<unknown> {return this.#transport.request("ui.playback", {action: "play"});}
  stop(): Promise<unknown> {return this.#transport.request("ui.playback", {action: "stop"});}
  seekFrame(frame: number): Promise<unknown> {return this.#execute("playhead.set", {frame: integer(frame, "frame")});}
  async undo(): Promise<{undone: string}> {
    const result = object(await this.#execute("edit.undo"), "undo response");
    if (typeof result.undone !== "string" || !result.undone) throw new AdapterError("response", "Undo did not return an operation label");
    return {undone: result.undone};
  }

  async preview(value: EditProposal): Promise<ProposalPreview> {
    const proposal = proposalInput(value);
    const project = await this.#inspectProject();
    if (project.revision !== proposal.expectedRevision || project.activeSequence !== proposal.sequence) throw new AdapterError("stale", "Project revision or active sequence changed; inspect and re-plan the proposal");
    // Rust repeats revision/provenance/range validation atomically at dispatch.
    const result = object(await this.#execute("proposal.preview", proposal as unknown as Record<string, unknown>), "preview response");
    const checkedToken = token(result.token);
    try {
      const expectedRevision = integer(result.expectedRevision, "preview.expectedRevision", 1);
      if (expectedRevision !== proposal.expectedRevision || result.label !== proposal.label || !Array.isArray(result.results)) throw new AdapterError("response", "Preview response does not match the requested revision or label");
      const sequence = sequenceResult(result.sequence);
      if (sequence.id !== proposal.sequence) throw new AdapterError("response", "Preview returned another sequence");
      return {token: checkedToken, expectedRevision, label: proposal.label, sequence, results: result.results};
    } catch (error) {
      // Rust has staged this token already. Release rejected candidates so validation
      // errors cannot leave an inaccessible preview blocking the next proposal.
      try {await this.#execute("proposal.cancel", {token: checkedToken});} catch {}
      throw error;
    }
  }

  async inspectPreview(value: ProposalToken): Promise<ProposalPreview> {
    const checked = token(value);
    const result = object(await this.#execute("proposal.inspect", {token: checked}), "preview response");
    if (token(result.token) !== checked || !Array.isArray(result.results)) throw new AdapterError("response", "Invalid preview inspection response");
    return {token: checked, expectedRevision: integer(result.expectedRevision, "preview.expectedRevision", 1), label: label(result.label), sequence: sequenceResult(result.sequence), results: result.results};
  }
  async cancel(value: ProposalToken): Promise<{cancelled: true}> {
    const result = object(await this.#execute("proposal.cancel", {token: token(value)}), "cancel response");
    if (result.cancelled !== true) throw new AdapterError("response", "Invalid cancellation confirmation");
    return {cancelled: true};
  }
  async commit(value: ProposalToken): Promise<{committed: true; revision: number; label: string}> {
    const result = object(await this.#execute("proposal.commit", {token: token(value)}), "commit response");
    if (result.committed !== true || typeof result.label !== "string" || !result.label) throw new AdapterError("response", "Invalid commit confirmation");
    return {committed: true, revision: integer(result.revision, "commit.revision"), label: result.label};
  }

  async previewFrame(value: ProposalToken, frame: number, maxSide = 256): Promise<{width: number; height: number; rgba: Uint8Array}> {
    const params = {token: token(value), frame: integer(frame, "frame"), maxSide: integer(maxSide, "maxSide", 1)};
    if (maxSide > 256) invalid("maxSide must be <=256");
    const deadline = Date.now() + 5000;
    const expired = () => new AdapterError("response", "Preview frame did not become ready within 5 seconds; retry after media finishes loading");
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw expired();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: unknown;
      try {
        // Rendering is read-only: also bound a request whose engine promise never settles.
        response = await Promise.race([
          this.#execute("proposal.render", params),
          new Promise<never>((_, reject) => {timer = setTimeout(() => reject(expired()), remaining);}),
        ]);
      } finally {clearTimeout(timer);}
      const result = object(response, "render response");
      if (result.pending === true) {
        keys(result, ["pending"], "pending render response");
        // Only the engine's explicit pending response permits another request.
        await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
        continue;
      }
      keys(result, ["width", "height", "rgba"], "render response");
      const width = integer(result.width, "render.width", 1), height = integer(result.height, "render.height", 1);
      if (width > maxSide || height > maxSide || !Array.isArray(result.rgba) || result.rgba.length !== width * height * 4 || Array.from(result.rgba).some(value => typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255)) throw new AdapterError("response", "Invalid preview pixel buffer");
      return {width, height, rgba: Uint8Array.from(result.rgba)};
    }
  }

  /**
   * Store a word-timed transcript on a recorded Movie/Audio source item via `transcript.set`.
   * Input is copied, validated and converted to ticks before any await, then bounded by the item's
   * current duration. One undoable "Set Transcript" edit; replaces any earlier transcript.
   */
  async importTranscript(value: TranscriptInput): Promise<SourceTranscript> {
    let transcript: SourceTranscript;
    try {transcript = parseTranscript(value);} catch (error) {
      if (error instanceof TranscriptError) invalid(error.message);
      throw error;
    }
    const project = await this.#inspectProject();
    const found = binItem(project.root, transcript.sourceItemId);
    if (!found) invalid(`Source item ${transcript.sourceItemId} is not in the project`);
    if (found.type !== "Movie" && found.type !== "Audio") invalid(`Source item ${transcript.sourceItemId} is not recorded media`);
    const duration = integer(found.duration, "source duration");
    // Words are ordered and non-overlapping, so the last end bounds them all.
    if ((transcript.words.at(-1)?.end ?? 0) > duration) invalid("Transcript ends after the source duration");
    const {sourceItemId: item, language, words} = transcript;
    const result = object(await this.#execute("transcript.set", {item, transcript: {language, words}}), "transcript response");
    if (result.item !== item || result.words !== words.length) throw new AdapterError("response", "transcript.set stored an unexpected item or word count");
    return transcript;
  }

  async export(settings: {path: string; bitrateKbps?: number}): Promise<{job: number; path: string}> {
    const input = object(settings, "export settings");
    keys(input, ["path", "bitrateKbps"], "export settings");
    const path = input.path;
    const bitrateKbps = input.bitrateKbps ?? 4000;
    if (typeof path !== "string" || path.length > 4096 || !/^\/exports\/[^/\\\x00]+\.mp4$/.test(path)) invalid("Export path must be an MP4 filename under /exports/");
    if (integer(bitrateKbps, "bitrateKbps", 1) > 4294967295) invalid("bitrateKbps exceeds u32 bounds");
    const result = object(await this.#execute("file.exportMedia", {path, format: "h264", range: "entire", audio: true, bitrateKbps}), "export response");
    if (result.path !== path) throw new AdapterError("response", "Export returned an unexpected path");
    return {job: integer(result.job, "job", 1), path};
  }

  async jobs(): Promise<ExportJob[]> {
    const jobs = await this.#execute("jobs.list");
    if (!Array.isArray(jobs)) throw new AdapterError("response", "jobs.list must return an array");
    for (const job of jobs) {
      integer(job?.id, "job.id", 1);
      if (typeof job.finished !== "boolean") throw new AdapterError("response", "Invalid export job response");
    }
    return jobs as ExportJob[];
  }
}
