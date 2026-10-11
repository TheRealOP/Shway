//! Bounded, source-backed proposals. Candidate commands run in a disposable session; the
//! authoritative project, history, persistence and playback remain untouched until commit.
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use filmcraft_project::{ClipId, ItemId, ItemKind, Project, TrackItem};
use filmcraft_time::{TICKS_PER_SECOND, Tick};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{EngineError, Result, Session};

const MAX_STEPS: usize = 16;
const MAX_TARGETS: usize = 32;
// The browser boundary must represent every integer exactly, including ticks and IDs.
const MAX_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) struct Prepared {
    token: u64,
    revision: u64,
    sequence: ItemId,
    label: String,
    base: Arc<Project>,
    candidate: Arc<Project>,
    context: Value,
    results: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Proposal {
    expected_revision: u64,
    sequence: u64,
    label: String,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(tag = "command", content = "params", deny_unknown_fields)]
enum Step {
    #[serde(rename = "timeline.trim")]
    Trim(Trim),
    #[serde(rename = "clip.replaceFromBin")]
    Replace(Replace),
    #[serde(rename = "timeline.place")]
    Place(Place),
    #[serde(rename = "timeline.remove")]
    Remove(Remove),
    #[serde(rename = "timeline.move")]
    Move(Move),
}

/// Ripple-delete explicit clips (with their linked partners); later material closes the gap.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Remove {
    clips: Vec<u64>,
}

/// Rearrange: `clip` (with its links) plays immediately before/after `anchor` on the same track.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Move {
    clip: u64,
    anchor: u64,
    position: Position,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Position {
    Before,
    After,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Trim {
    clip: u64,
    source: u64,
    edge: Edge,
    mode: Mode,
    delta_frames: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Edge {
    In,
    Out,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Regular,
    Ripple,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Replace {
    clips: Vec<u64>,
    item: u64,
    #[serde(default)]
    keep_source_in: bool,
}

/// Explicit source ranges appended, in order, after everything already in the active sequence.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Place {
    ranges: Vec<SourceRange>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourceRange {
    item: u64,
    source_in: i64,
    source_out: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    token: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Render {
    token: u64,
    frame: i64,
    #[serde(default = "render_side")]
    max_side: u32,
}

fn render_side() -> u32 {
    256
}

fn bad(message: impl Into<String>) -> EngineError {
    EngineError::Other(format!("edit proposal: {}", message.into()))
}

fn parse<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T> {
    T::deserialize(v).map_err(|e| bad(format!("invalid parameters: {e}")))
}

fn id(value: u64) -> Result<u64> {
    if value == 0 || value > MAX_INTEGER {
        return Err(bad("IDs must be positive exact browser integers"));
    }
    Ok(value)
}

fn tick(value: i64) -> Result<Tick> {
    if value.unsigned_abs() > MAX_INTEGER || !(Tick::MIN.0..=Tick::MAX.0).contains(&value) {
        return Err(bad("time exceeds exact supported ticks"));
    }
    Ok(Tick(value))
}

// Selection and command-dependent context are checked again even when project revision stayed
// unchanged. Seeking and viewport navigation remain available while inspecting a proposal.
fn context(s: &Session) -> Value {
    json!({
        "sequence": s.state.active_sequence, "selection": s.state.selection,
        "projectSelection": s.state.project_selection, "linked": s.state.linked_selection,
        "targeting": s.state.targeting, "rippleMarkers": s.state.ripple_sequence_markers,
        "editPoints": s.state.edit_points,
    })
}

fn stage(s: &Session, project: Arc<Project>) -> Session {
    let mut out = Session::new(s.services.clone());
    out.project = project;
    out.state = s.state.clone();
    out.media = s.media.clone();
    out.prefs = s.prefs.clone();
    // Always preserve linked partners, irrespective of the user's selection toggle.
    out.state.linked_selection = true;
    out
}

fn frame_ticks(s: &Session) -> Result<i64> {
    let settings = &s.active_sequence().ok_or(EngineError::NoSequence)?.settings;
    settings.validate().map_err(bad)?;
    let ticks = settings.frame_rate.frame_duration().0;
    if ticks <= 0 {
        return Err(bad("frame duration must be positive"));
    }
    Ok(ticks)
}

fn source_duration(s: &Session, source: ItemId) -> Result<Tick> {
    let item = s.project.item(source).ok_or_else(|| bad("missing source item"))?;
    let ItemKind::Media(media) = &item.kind else {
        return Err(bad("only finite media sources are supported; nested sequences and subclips require a separate proposal"));
    };
    if media.offline {
        return Err(bad("source is offline; relink it before proposing an edit"));
    }
    tick(media.info.duration.0)?;
    if media.info.duration <= Tick::ZERO {
        return Err(bad("source must have a known positive duration"));
    }
    // Replace From Bin derives a marked range with source-frame arithmetic. Reject corrupt
    // rates/marks before that command can add an untrusted Out point to a frame duration.
    let rate = media.frame_rate();
    if rate.num <= 0 || rate.den <= 0 || rate.as_f64() > 1000.0 {
        return Err(bad("source frame rate must be valid and positive"));
    }
    let frame_ticks = i128::from(TICKS_PER_SECOND) * i128::from(rate.den) / i128::from(rate.num);
    let frame = tick(i64::try_from(frame_ticks).map_err(|_| bad("source frame duration overflow"))?)?;
    if frame <= Tick::ZERO {
        return Err(bad("source frame duration must be positive"));
    }
    for mark in media.mark_in.into_iter().chain(media.mark_out) {
        tick(mark.0)?;
        if mark < Tick::ZERO || mark >= media.info.duration {
            return Err(bad("source marks must be within the source duration"));
        }
        tick(mark.0.checked_add(frame.0).ok_or_else(|| bad("source mark overflow"))?)?;
    }
    if media.mark_in.zip(media.mark_out).is_some_and(|(start, end)| end < start) {
        return Err(bad("source Out precedes In"));
    }
    Ok(media.info.duration)
}

fn check_clip(s: &Session, c: ClipId) -> Result<&TrackItem> {
    let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let (track, clip) = q.find_item(c).ok_or_else(|| bad(format!("missing clip {}", c.0)))?;
    if q.track(track).is_none_or(|t| t.locked) {
        return Err(bad("target or linked partner is on a locked track"));
    }
    if !clip.speed.is_finite() || clip.speed != 1.0 || clip.reverse || clip.frame_hold.is_some() || clip.multicam.is_some() {
        return Err(bad("speed, reverse, held-frame and multicamera clips are unsupported"));
    }
    let end = source_duration(s, clip.item)?;
    let out = clip.source_in.0.checked_add(clip.duration.0).ok_or_else(|| bad("source range overflow"))?;
    tick(clip.start.0)?;
    tick(clip.duration.0)?;
    tick(clip.source_in.0)?;
    tick(out)?;
    tick(clip.start.0.checked_add(clip.duration.0).ok_or_else(|| bad("sequence range overflow"))?)?;
    if clip.start < Tick::ZERO || clip.source_in < Tick::ZERO || clip.duration <= Tick::ZERO || out > end.0 {
        return Err(bad("clip range must be positive and contained in its source"));
    }
    Ok(clip)
}

fn targets(s: &Session, values: &[u64]) -> Result<Vec<ClipId>> {
    if values.is_empty() || values.len() > MAX_TARGETS {
        return Err(bad("need 1–32 explicit clips"));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        id(*value)?;
        if !unique.insert(*value) {
            return Err(bad("duplicate clip target"));
        }
        check_clip(s, ClipId(*value))?;
    }
    let clips: Vec<_> = values.iter().copied().map(ClipId).collect();
    let expanded = crate::commands::with_links(s, &clips);
    if expanded.len() > MAX_TARGETS {
        return Err(bad("too many linked partners"));
    }
    for c in &expanded {
        let clip = check_clip(s, *c)?;
        if let Some(link) = clip.link {
            for other in &expanded {
                let peer = check_clip(s, *other)?;
                if peer.link == Some(link)
                    && (peer.item != clip.item || peer.source_in != clip.source_in || peer.start != clip.start || peer.duration != clip.duration)
                {
                    return Err(bad("linked A/V must share source and synchronized ranges"));
                }
            }
        }
    }
    Ok(expanded)
}

fn apply(s: &mut Session, step: Step) -> Result<Value> {
    match step {
        Step::Trim(p) => {
            id(p.source)?;
            let clips = targets(s, &[p.clip])?;
            if check_clip(s, ClipId(p.clip))?.item != ItemId(p.source) {
                return Err(bad("trim source does not match its explicit clip"));
            }
            let delta = p.delta_frames.checked_mul(frame_ticks(s)?).ok_or_else(|| bad("frame delta overflow"))?;
            tick(delta)?;
            if delta == 0 {
                return Err(bad("trim must change at least one frame"));
            }
            let edge = match p.edge {
                Edge::In => "in",
                Edge::Out => "out",
            };
            let mode = match p.mode {
                Mode::Regular => "regular",
                Mode::Ripple => "ripple",
            };
            let result = s.execute("timeline.trim", json!({"clip": p.clip, "edge": edge, "mode": mode, "delta": delta}))?;
            if result.get("delta").and_then(Value::as_i64) != Some(delta) {
                return Err(bad("trim exceeds a source, sync or neighbor limit; re-plan the exact range"));
            }
            for clip in clips {
                check_clip(s, clip)?;
            }
            Ok(result)
        }
        Step::Replace(p) => {
            id(p.item)?;
            source_duration(s, ItemId(p.item))?;
            let clips = targets(s, &p.clips)?;
            let item = s.project.item(ItemId(p.item)).ok_or_else(|| bad("missing replacement source"))?;
            let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
            for c in &clips {
                let (t, _) = q.find_item(*c).ok_or_else(|| bad("missing clip"))?;
                let track = q.track(t).ok_or_else(|| bad("missing track"))?;
                if (track.kind == filmcraft_project::TrackKind::Audio && !item.has_audio())
                    || (track.kind == filmcraft_project::TrackKind::Video && !item.has_video())
                {
                    return Err(bad("replacement must provide every targeted video/audio stream"));
                }
            }
            let result = s.execute("clip.replaceFromBin", json!({"clips":p.clips,"item":p.item,"keepSourceIn":p.keep_source_in}))?;
            if result.get("clips").and_then(Value::as_array).is_none_or(|v| v.len() != clips.len()) {
                return Err(bad("replacement did not affect every linked target"));
            }
            for clip in &clips {
                check_clip(s, *clip)?;
            }
            // Revalidate linked ranges after applying marks from the replacement source.
            targets(s, &p.clips)?;
            Ok(result)
        }
        Step::Place(p) => {
            // preview() already bounded the cumulative count before parsing.
            if p.ranges.is_empty() {
                return Err(bad("need at least one source range"));
            }
            frame_ticks(s)?;
            let rate = s.sequence_rate();
            let mut placed = Vec::with_capacity(p.ranges.len());
            for r in p.ranges {
                id(r.item)?;
                let end = source_duration(s, ItemId(r.item))?;
                let (start, out) = (tick(r.source_in)?, tick(r.source_out)?);
                if start < Tick::ZERO || out <= start || out > end {
                    return Err(bad("each range needs 0 <= sourceIn < sourceOut <= source duration"));
                }
                // timeline.place would silently snap a fractional duration; the caller rounds instead.
                if rate.snap(start) != start || rate.snap(out) != out {
                    return Err(bad("sourceIn and sourceOut must lie on sequence frame boundaries; round explicitly before proposing"));
                }
                // timeline.place itself rejects V1 for an item without a picture.
                let audio = s.project.item(ItemId(r.item)).ok_or_else(|| bad("missing source item"))?.has_audio();
                let duration = out.0.checked_sub(start.0).ok_or_else(|| bad("source range overflow"))?;
                // Append after every track's content: overwrite then never touches existing clips.
                let at = s.active_sequence().ok_or(EngineError::NoSequence)?.duration();
                tick(at.0.checked_add(duration).ok_or_else(|| bad("sequence range overflow"))?)?;
                let mut params =
                    json!({"item":r.item,"track":"V1","time":at.0,"sourceIn":start.0,"duration":duration,"insert":false,"video":true,"audio":audio});
                if audio {
                    params["audioTrack"] = json!("A1");
                }
                let result = s.execute("timeline.place", params)?;
                let clips: Vec<u64> = result.get("clips").and_then(Value::as_array).map(|v| v.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
                // Locks, source containment and linked A/V sync of everything just placed.
                // timeline.place errors (never drops a stream) for missing or locked V1/A1.
                for c in &targets(s, &clips)? {
                    let clip = check_clip(s, *c)?;
                    if clip.item != ItemId(r.item) || clip.start != at || clip.source_in != start || clip.duration.0 != duration {
                        return Err(bad("placement does not match the exact requested range"));
                    }
                }
                placed.push(json!({"item":r.item,"start":at.0,"sourceIn":start.0,"sourceOut":out.0,"clips":clips}));
            }
            Ok(json!({"placed":placed}))
        }
        Step::Remove(p) => {
            let clips = targets(s, &p.clips)?;
            let before = s.active_sequence().ok_or(EngineError::NoSequence)?.duration();
            // The engine's own Ripple Delete: partners, sync locks and markers as the user knows it.
            s.execute("edit.rippleDelete", json!({"clips":p.clips}))?;
            let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
            if clips.iter().any(|c| q.find_item(*c).is_some()) {
                return Err(bad("ripple delete did not remove every linked target"));
            }
            let closed = before.0.checked_sub(q.duration().0).ok_or_else(|| bad("sequence duration overflow"))?;
            Ok(json!({"removed":clips.iter().map(|c| c.0).collect::<Vec<_>>(),"closed":closed}))
        }
        Step::Move(p) => rearrange(s, &p),
    }
}

/// Insert-move the clip to the anchor's edge (`timeline.move`), then close the hole it left
/// (`sequence.closeGap`). The result is checked against the exact rearrangement, so a sync-lock
/// conflict, a pre-existing gap or an unsynced partner becomes an error, never a desync.
fn rearrange(s: &mut Session, p: &Move) -> Result<Value> {
    if p.clip == p.anchor {
        return Err(bad("clip and anchor must differ"));
    }
    let moved = targets(s, &[p.clip])?;
    if targets(s, &[p.anchor])?.iter().any(|c| moved.contains(c)) {
        return Err(bad("anchor is linked to the moved clip"));
    }
    let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let (track, clip) = q.find_item(ClipId(p.clip)).ok_or_else(|| bad("missing clip"))?;
    let (anchor_track, anchor) = q.find_item(ClipId(p.anchor)).ok_or_else(|| bad("missing anchor"))?;
    if track != anchor_track {
        return Err(bad("anchor must be on the moved clip's track"));
    }
    let (start, end, d) = (clip.start.0, clip.end().0, clip.duration.0);
    let at = if p.position == Position::Before { anchor.start.0 } else { anchor.end().0 };
    if at == start || at == end {
        return Err(bad("clip already plays there"));
    }
    // Exact expectation: material between the old and new place shifts by the clip's length on
    // the moved clips' tracks and on every unlocked sync-locked track; nothing else changes.
    let later = at > start;
    let overflow = || bad("move range overflow");
    let (new_start, gap) = if later { (at.checked_sub(d).ok_or_else(overflow)?, start) } else { (at, end) };
    let mut expected = Vec::new();
    for t in q.all_tracks() {
        let rippled = !t.locked && (t.sync_lock || t.items.iter().any(|i| moved.contains(&i.id)));
        for i in &t.items {
            let x = i.start.0;
            let shift = if moved.contains(&i.id) {
                new_start.checked_sub(x).ok_or_else(overflow)?
            } else if rippled && later && x >= end && x < at {
                -d
            } else if rippled && !later && x >= at && x < start {
                d
            } else {
                0
            };
            expected.push((i.id, t.id, x.checked_add(shift).ok_or_else(overflow)?));
        }
    }
    // A rearrangement keeps the sequence length, so sequence markers stay where they are.
    let markers = std::mem::replace(&mut s.state.ripple_sequence_markers, false);
    let result = s.execute("timeline.move", json!({"moves":[{"clip":p.clip,"track":track.0,"time":at}],"insert":true,"linked":true})).and_then(|_| {
        // Moving earlier pushes the hole right by the clip's own length: it now starts at `end`.
        // A hole at the very end of the track is no gap: nothing follows it.
        let tail = s.active_sequence().and_then(|q| q.track(track)).is_none_or(|t| t.items.iter().all(|i| i.start.0 < gap));
        if tail { Ok(Value::Null) } else { s.execute("sequence.closeGap", json!({"track":track.0,"time":gap})) }
    });
    s.state.ripple_sequence_markers = markers;
    result?;
    let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let actual: Vec<_> = q.all_tracks().flat_map(|t| t.items.iter().map(move |i| (i.id, t.id, i.start.0))).collect();
    if actual.len() != expected.len() || expected.iter().any(|e| !actual.contains(e)) {
        return Err(bad("move cannot ripple every affected track identically (sync lock, gap or partner); re-plan"));
    }
    for c in &moved {
        check_clip(s, *c)?;
    }
    Ok(json!({"moved":moved.iter().map(|c| c.0).collect::<Vec<_>>(),"start":new_start}))
}

fn prepared(s: &Session, token: u64) -> Result<&Prepared> {
    id(token)?;
    s.proposal.as_ref().filter(|p| p.token == token).ok_or_else(|| bad("unknown or expired preview token"))
}

fn fresh(s: &Session, p: &Prepared) -> Result<()> {
    if s.revision != p.revision || !Arc::ptr_eq(&s.project, &p.base) || context(s) != p.context || s.trim_play.active() {
        return Err(bad("stale project or interaction context; preview again"));
    }
    Ok(())
}

fn describe(s: &Session, p: &Prepared) -> Result<Value> {
    let staged = stage(s, p.candidate.clone());
    let sequence = staged.project.sequence(p.sequence).ok_or(EngineError::NoSequence)?;
    Ok(
        json!({"token":p.token,"expectedRevision":p.revision,"label":p.label,"sequence":crate::commands::inspect_sequence(&staged,p.sequence,sequence),"results":p.results}),
    )
}

pub fn preview(s: &mut Session, v: &Value) -> Result<Value> {
    // Bounds precede deserialization: neither steps nor nested clip lists may allocate an
    // unbounded second copy of an already parsed control request.
    let steps = v.get("steps").and_then(Value::as_array).ok_or_else(|| bad("need explicit steps"))?;
    if steps.is_empty() || steps.len() > MAX_STEPS {
        return Err(bad("need 1–16 proposal steps"));
    }
    let mut target_count = 0usize;
    for step in steps {
        let params = step.get("params");
        let list = params.and_then(|p| p.get("clips").or_else(|| p.get("ranges")));
        // A move references both its clip and its anchor.
        let count = list.and_then(Value::as_array).map_or(1, Vec::len) + usize::from(params.is_some_and(|p| p.get("anchor").is_some()));
        target_count = target_count.checked_add(count).ok_or_else(|| bad("target count overflow"))?;
        if target_count > MAX_TARGETS {
            return Err(bad("at most 32 explicit target references across the proposal"));
        }
    }
    if v.get("label").and_then(Value::as_str).is_some_and(|l| l.len() > 120) {
        return Err(bad("label is longer than 120 bytes"));
    }
    let p: Proposal = parse(v)?;
    id(p.sequence)?;
    id(p.expected_revision)?;
    if p.label.trim().is_empty() {
        return Err(bad("need a descriptive label"));
    }
    if s.proposal.is_some() {
        return Err(bad("cancel or commit the current preview before proposing another"));
    }
    if s.revision != p.expected_revision || s.state.active_sequence != Some(ItemId(p.sequence)) || s.trim_play.active() {
        return Err(bad("stale revision, different active sequence or active dynamic trim"));
    }
    s.active_sequence().ok_or(EngineError::NoSequence)?.check().map_err(bad)?;
    let mut staged = stage(s, s.project.clone());
    let mut results = Vec::with_capacity(p.steps.len());
    for step in p.steps {
        results.push(apply(&mut staged, step)?);
        staged.active_sequence().ok_or(EngineError::NoSequence)?.check().map_err(bad)?;
    }
    let token = id(s.next_proposal)?;
    let next = s.next_proposal.checked_add(1).ok_or_else(|| bad("preview token limit reached"))?;
    let prepared = Prepared {
        token,
        revision: p.expected_revision,
        sequence: ItemId(p.sequence),
        label: p.label,
        base: s.project.clone(),
        candidate: staged.project,
        context: context(s),
        results,
    };
    let response = describe(s, &prepared)?;
    s.proposal = Some(prepared);
    s.next_proposal = next;
    Ok(response)
}

pub fn inspect(s: &Session, v: &Value) -> Result<Value> {
    let p: Token = parse(v)?;
    let p = prepared(s, p.token)?;
    fresh(s, p)?;
    describe(s, p)
}

pub fn cancel(s: &mut Session, v: &Value) -> Result<Value> {
    let p: Token = parse(v)?;
    prepared(s, p.token)?;
    // A stale candidate can always be discarded without reverting the user's newer work.
    s.proposal = None;
    Ok(json!({"cancelled":true}))
}

pub fn commit(s: &mut Session, v: &Value) -> Result<Value> {
    let token: Token = parse(v)?;
    let p = prepared(s, token.token)?;
    fresh(s, p)?;
    let candidate = p.candidate.clone();
    let label = p.label.clone();
    let seq = candidate.sequence(p.sequence).ok_or(EngineError::NoSequence)?;
    seq.check().map_err(bad)?;
    // Preserve navigation/selection made while viewing the candidate. Only the project changes.
    s.edit(&label, |project, _| {
        *project = (*candidate).clone();
        Ok(())
    })?;
    s.proposal = None;
    Ok(json!({"committed":true,"revision":s.revision,"label":label}))
}

pub fn render(s: &Session, v: &Value) -> Result<Value> {
    let r: Render = parse(v)?;
    if !(1..=256).contains(&r.max_side) || r.frame < 0 {
        return Err(bad("render needs a nonnegative frame and maxSide in 1–256"));
    }
    let p = prepared(s, r.token)?;
    fresh(s, p)?;
    let staged = stage(s, p.candidate.clone());
    let q = staged.active_sequence().ok_or(EngineError::NoSequence)?;
    let time = tick(r.frame.checked_mul(frame_ticks(&staged)?).ok_or_else(|| bad("frame overflow"))?)?;
    if time >= q.duration() {
        return Err(bad("render frame is outside the candidate sequence"));
    }
    for track in q.video_tracks.iter().filter(|t| t.enabled) {
        for clip in track.items.iter().filter(|c| c.enabled && time >= c.start && time < c.end()) {
            if staged.project.item(clip.item).is_none() {
                return Err(bad(format!("source {} cannot be opened: missing project item", clip.item.0)));
            }
        }
    }
    let side = q.settings.width.max(q.settings.height);
    if side == 0 {
        return Err(bad("invalid render dimensions"));
    }
    let scale = (r.max_side as f32 / side as f32).min(1.0);
    let (width, height) = filmcraft_render::output_size(q, scale);
    let count = width.checked_mul(height).and_then(|n| n.checked_mul(4));
    if width == 0 || height == 0 || width > 256 || height > 256 || count.is_none_or(|n| n > 256 * 256 * 4) {
        return Err(bad("candidate render exceeds bounded pixel dimensions"));
    }
    // The compositor skips failed decodes and the pool provides an offline slate. Observe the
    // exact source requests so neither can be advertised as a complete candidate frame.
    filmcraft_media::pending::take();
    let error = Arc::new(Mutex::new(None::<String>));
    let provider = |item: ItemId| {
        let prior_pending = filmcraft_media::pending::take();
        let source = staged.media.full_res_source(&staged.project, item, &*staged.services);
        let local_pending = filmcraft_media::pending::take();
        if prior_pending || local_pending {
            filmcraft_media::pending::mark();
        }
        if let Some(offline) = staged.media.offline_status(item) {
            *error.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("source {} is unavailable: {}", item.0, offline.error));
            return None;
        }
        if source.is_none() && !local_pending {
            *error.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("source {} cannot be opened", item.0));
        }
        source.map(|source| Arc::new(CheckedSource { source, error: error.clone() }) as filmcraft_media::SharedSource)
    };
    let image = filmcraft_render::render_sequence(
        &staged.project,
        p.sequence,
        time,
        filmcraft_render::RenderOptions { scale, captions: true, ..Default::default() },
        &provider,
    );
    let pending = filmcraft_media::pending::take();
    if let Some(error) = error.lock().unwrap_or_else(|e| e.into_inner()).take() {
        return Err(bad(error));
    }
    if pending {
        return Ok(json!({"pending":true}));
    }
    let rgba = image.to_rgba8();
    if image.w != width || image.h != height || Some(rgba.len()) != count {
        return Err(bad("candidate render returned inconsistent pixel dimensions"));
    }
    Ok(json!({"width":image.w,"height":image.h,"rgba":rgba}))
}

/// Preserve decoder errors that the general compositor intentionally treats as an empty layer.
struct CheckedSource {
    source: filmcraft_media::SharedSource,
    error: Arc<Mutex<Option<String>>>,
}

impl filmcraft_media::MediaSource for CheckedSource {
    fn info(&self) -> &filmcraft_media::MediaInfo {
        self.source.info()
    }

    fn video_frame(&self, request: filmcraft_media::FrameRequest) -> filmcraft_media::Result<Arc<filmcraft_frame::VideoFrame>> {
        let prior_pending = filmcraft_media::pending::take();
        let result = self.source.video_frame(request);
        let local_pending = filmcraft_media::pending::take();
        if prior_pending || local_pending {
            filmcraft_media::pending::mark();
        }
        if !local_pending && let Err(e) = &result {
            *self.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("candidate video decode failed: {e}"));
        }
        result
    }

    fn audio(&self, start: i64, frames: usize, sample_rate: u32) -> filmcraft_media::Result<filmcraft_frame::AudioBuffer> {
        self.source.audio(start, frames, sample_rate)
    }
}

#[cfg(test)]
mod tests;
