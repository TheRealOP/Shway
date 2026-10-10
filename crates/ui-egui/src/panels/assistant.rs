//! Assistant panel (Shway): a chat with the local assistant service that edits the video through
//! the control channel as previewed proposals. This panel is only the conversation and the
//! Accept / Reject buttons; the service (`node shway/assistant.mjs`) does the work.
//!
//! The service listens on `SHWAY_ASSISTANT_URL` (default `http://127.0.0.1:8793`, loopback only):
//! `GET /chat/state`, `POST /chat {message}`, `POST /chat/accept {}`, `POST /chat/reject {}`.
//! Requests run on a background thread; the panel polls `/chat/state` every 2 s while visible.
//! On the web build there is no networking and the panel says so.
//!
//! Automation ids: `assistant.input`, `assistant.send`, `assistant.accept`, `assistant.reject`,
//! `assistant.pending`, `assistant.error`, `assistant.thinking`, `assistant.message.<i>`,
//! `assistant.suggestion.<i>` (example prompts on the empty conversation).
//! UI commands: `assistant.send {text}`, `assistant.accept`, `assistant.reject`. The conversation
//! is `ui.assistant` in `ui.inspect`.

use std::sync::mpsc::Receiver;

use egui::{Rect, RichText, vec2};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::FilmcraftApp;

/// Shown when the service can't be reached.
pub const NOT_RUNNING: &str = "Assistant service not running: start it with `node shway/assistant.mjs`";
/// Longest message the service accepts, in characters.
pub const MAX_MESSAGE: usize = 2000;
const POLL_SECS: f64 = 2.0;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub text: String,
}

/// An edit the service has previewed and waits for the creator to accept or reject.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Pending {
    pub token: i64,
    pub label: String,
}

/// `GET /chat/state`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ChatState {
    pub messages: Vec<Message>,
    #[serde(default)]
    pub pending: Option<Pending>,
    #[serde(default)]
    pub busy: bool,
}

/// `POST /chat`, `/chat/accept`, `/chat/reject`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ChatReply {
    pub reply: String,
    #[serde(default)]
    pub pending: Option<Pending>,
    #[serde(default)]
    pub busy: bool,
}

/// The panel's state (serde: `ui.assistant` in `ui.inspect`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssistantUi {
    pub messages: Vec<Message>,
    pub pending: Option<Pending>,
    /// The service says it is working.
    pub busy: bool,
    /// A send / accept / reject of ours is in flight.
    pub waiting: bool,
    pub error: Option<String>,
    pub draft: String,
}

impl AssistantUi {
    pub fn thinking(&self) -> bool {
        self.waiting || self.busy
    }

    /// Validate `text` and record it as sent. Returns the message to post.
    pub fn begin_send(&mut self, text: &str) -> Result<String, String> {
        if self.waiting {
            return Err("The assistant is still answering".into());
        }
        let text = text.trim();
        if text.is_empty() {
            return Err("Type a message first".into());
        }
        if text.chars().count() > MAX_MESSAGE {
            return Err(format!("Messages are limited to {MAX_MESSAGE} characters"));
        }
        self.messages.push(Message { role: "user".into(), text: text.into() });
        self.waiting = true;
        self.error = None;
        self.draft.clear();
        Ok(text.into())
    }

    /// Start an accept / reject of the pending edit.
    pub fn begin_decision(&mut self) -> Result<(), String> {
        if self.waiting {
            return Err("The assistant is still answering".into());
        }
        if self.pending.is_none() {
            return Err("There is no proposed edit to accept or reject".into());
        }
        self.waiting = true;
        self.error = None;
        Ok(())
    }

    /// The answer to a send / accept / reject.
    pub fn apply_reply(&mut self, r: Result<ChatReply, String>) {
        self.waiting = false;
        match r {
            Ok(r) => {
                if !r.reply.is_empty() {
                    self.messages.push(Message { role: "assistant".into(), text: r.reply });
                }
                self.pending = r.pending;
                self.busy = r.busy;
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
    }

    /// A `/chat/state` poll: the service's conversation replaces ours.
    pub fn apply_state(&mut self, r: Result<ChatState, String>) {
        match r {
            Ok(s) => {
                self.messages = s.messages;
                self.pending = s.pending;
                self.busy = s.busy;
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
    }
}

type Answer = Result<Value, String>;

/// Requests in flight (not serialized; lives on [`FilmcraftApp`]).
#[derive(Default)]
pub struct Client {
    action: Option<Receiver<Answer>>,
    poll: Option<Receiver<Answer>>,
    last_poll: Option<f64>,
}

/// Run one request on a background thread; the answer arrives on the returned channel.
#[cfg(not(target_arch = "wasm32"))]
fn spawn(ctx: &egui::Context, method: &'static str, path: &'static str, body: Option<Value>) -> Receiver<Answer> {
    let (tx, rx) = std::sync::mpsc::channel();
    let ctx = ctx.clone();
    let fail = tx.clone();
    let run = move || {
        let r =
            std::panic::catch_unwind(|| http::call(method, path, body.as_ref())).unwrap_or_else(|_| Err("the assistant request failed unexpectedly".into()));
        let _ = tx.send(r);
        ctx.request_repaint();
    };
    if let Err(e) = std::thread::Builder::new().name("assistant-http".into()).spawn(run) {
        let _ = fail.send(Err(format!("could not start the assistant request: {e}")));
    }
    rx
}

#[cfg(target_arch = "wasm32")]
fn spawn(_ctx: &egui::Context, _method: &'static str, _path: &'static str, _body: Option<Value>) -> Receiver<Answer> {
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = tx.send(Err(WEB_ONLY.into()));
    rx
}

const WEB_ONLY: &str = "The assistant is available in the desktop app.";

fn decode<T: serde::de::DeserializeOwned>(a: Answer) -> Result<T, String> {
    a.and_then(|v| serde_json::from_value(v).map_err(|e| format!("the assistant service sent an unexpected answer: {e}")))
}

/// Take answers that arrived; start a poll when one is due (`now` in seconds).
fn tick(app: &mut FilmcraftApp, ctx: &egui::Context, now: f64) {
    let c = &mut app.assistant;
    if let Some(rx) = &c.action
        && let Ok(a) = rx.try_recv()
    {
        c.action = None;
        app.ui.assistant.apply_reply(decode(a));
        c.last_poll = None; // sync right away
    }
    if let Some(rx) = &c.poll
        && let Ok(a) = rx.try_recv()
    {
        c.poll = None;
        // a poll that started before our send doesn't know our message yet
        if c.action.is_none() && !app.ui.assistant.waiting {
            app.ui.assistant.apply_state(decode(a));
        }
    }
    let due = c.last_poll.is_none_or(|t| now - t >= POLL_SECS);
    if due && c.poll.is_none() && c.action.is_none() && !cfg!(target_arch = "wasm32") {
        c.poll = Some(spawn(ctx, "GET", "/chat/state", None));
        c.last_poll = Some(now);
    }
}

fn send(app: &mut FilmcraftApp, ctx: &egui::Context, text: &str) -> Result<Value, String> {
    if cfg!(target_arch = "wasm32") {
        return Err(WEB_ONLY.into());
    }
    let msg = app.ui.assistant.begin_send(text)?;
    app.assistant.action = Some(spawn(ctx, "POST", "/chat", Some(json!({"message": msg}))));
    Ok(json!({"sent": true}))
}

fn decide(app: &mut FilmcraftApp, ctx: &egui::Context, accept: bool) -> Result<Value, String> {
    if cfg!(target_arch = "wasm32") {
        return Err(WEB_ONLY.into());
    }
    app.ui.assistant.begin_decision()?;
    let path = if accept { "/chat/accept" } else { "/chat/reject" };
    app.assistant.action = Some(spawn(ctx, "POST", path, Some(json!({}))));
    Ok(json!({"sent": true}))
}

/// `assistant.send {text}`, `assistant.accept`, `assistant.reject`. They return once the request
/// is on its way; the answer shows in `ui.assistant`.
pub fn route(app: &mut FilmcraftApp, ctx: &egui::Context, id: &str, params: &Value) -> Option<Result<Value, String>> {
    Some(match id {
        "assistant.send" => match params.get("text").and_then(Value::as_str) {
            Some(text) => send(app, ctx, text),
            None => Err("assistant.send needs {\"text\": \"…\"}".into()),
        },
        "assistant.accept" => decide(app, ctx, true),
        "assistant.reject" => decide(app, ctx, false),
        _ => return None,
    })
}

/// Example prompts on the empty conversation.
pub const SUGGESTIONS: [&str; 3] = ["Remove the Chili's part", "Trim the first clip by 1 second", "What happens around 6 minutes?"];
/// The command that starts the service, shown when it can't be reached.
const START_COMMAND: &str = "node shway/assistant.mjs";

// Layout of the chat (colours come from the theme's `Visuals`).
const PAD: f32 = 14.0;
const GAP: f32 = 10.0;
const RADIUS: u8 = 14;
const TAIL: u8 = 4;
const BODY: f32 = 14.0;
const LINE: f32 = 20.0;
const MAX_INPUT_LINES: f32 = 6.0;

/// Enter (without Shift) pressed in the focused input: take it before the text field sees it.
fn take_enter(i: &mut egui::InputState) -> bool {
    let before = i.events.len();
    i.events.retain(|e| !matches!(e, egui::Event::Key { key: egui::Key::Enter, pressed: true, modifiers, .. } if !modifiers.shift));
    i.events.len() != before
}

fn bubble_radius(user: bool) -> egui::CornerRadius {
    let mut r = egui::CornerRadius::same(RADIUS);
    if user {
        r.se = TAIL;
    } else {
        r.sw = TAIL;
    }
    r
}

pub fn show(app: &mut FilmcraftApp, ui: &mut egui::Ui, rect: Rect) {
    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect.shrink(PAD)));
    let ui = &mut child;
    let v = ui.visuals().clone();
    let (accent, on_accent, text, weak) = (v.selection.bg_fill, v.selection.stroke.color, v.text_color(), v.weak_text_color());
    // a raised surface: a faint wash of the text colour, so it shows on any panel background
    let surface = text.gamma_multiply(0.07);
    if cfg!(target_arch = "wasm32") {
        ui.label(RichText::new(tl!("The assistant is available in the desktop app.")).color(weak));
        return;
    }
    let ctx = ui.ctx().clone();
    tick(app, &ctx, ui.input(|i| i.time));
    ctx.request_repaint_after(std::time::Duration::from_secs_f64(POLL_SECS));

    let edit_id = egui::Id::new("assistant-input");
    let focused = ctx.memory(|m| m.has_focus(edit_id));
    // Enter sends, Shift+Enter is a newline; Esc leaves the input.
    let enter = focused && ui.input_mut(take_enter);
    if focused && ui.input(|i| i.key_pressed(egui::Key::Escape)) {
        ctx.memory_mut(|m| m.surrender_focus(edit_id));
    }

    let mut elems: Vec<(String, Rect, String)> = Vec::new();
    let mut do_send = enter;
    let mut suggestion = None;
    let mut decision = None;
    let st = &mut app.ui.assistant;
    let body = |s: &str| RichText::new(s).size(BODY).line_height(Some(LINE));
    ui.spacing_mut().item_spacing.y = GAP;
    egui::Panel::bottom("assistant-bottom")
        .resizable(false)
        .show_separator_line(false)
        .frame(egui::Frame::NONE.inner_margin(egui::Margin { top: GAP as i8, ..Default::default() }))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = GAP;
            // errors; an unreachable service gets the command that starts it
            if let Some(e) = &st.error {
                let red = v.error_fg_color;
                let frame = egui::Frame::new()
                    .fill(red.gamma_multiply(0.12))
                    .stroke(egui::Stroke::new(1.0, red.gamma_multiply(0.5)))
                    .corner_radius(RADIUS)
                    .inner_margin(12);
                let banner = frame.show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.spacing_mut().item_spacing.y = 6.0;
                    if e == NOT_RUNNING {
                        ui.label(body(tl!("The assistant isn't running")).strong().color(text));
                        ui.add(egui::Label::new(RichText::new(tl!("Start it in a terminal, then send your message again:")).color(weak)).wrap());
                        egui::Frame::new().fill(v.extreme_bg_color).corner_radius(8).inner_margin(egui::Margin::symmetric(8, 6)).show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.add(egui::Label::new(RichText::new(START_COMMAND).monospace().color(text)).wrap());
                        });
                    } else {
                        ui.add(egui::Label::new(body(crate::i18n::t(e)).color(text)).wrap());
                    }
                });
                elems.push(("assistant.error".into(), banner.response.rect, e.clone()));
            }
            // the proposed edit, waiting for a decision
            if let Some(p) = &st.pending {
                let card = egui::Frame::new().fill(surface).stroke(egui::Stroke::new(1.0, accent)).corner_radius(RADIUS).inner_margin(12).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.spacing_mut().item_spacing.y = 6.0;
                    ui.label(RichText::new(tl!("PROPOSED EDIT")).small().strong().color(accent));
                    ui.add(egui::Label::new(body(&p.label).color(text)).wrap());
                    ui.add_space(4.0);
                    ui.horizontal(|ui| {
                        let w = ((ui.available_width() - ui.spacing().item_spacing.x) / 2.0).max(40.0);
                        let accept =
                            egui::Button::new(RichText::new(tl!("Accept")).strong().color(on_accent)).fill(accent).corner_radius(10).min_size(vec2(w, 32.0));
                        let ok = ui.add_enabled(!st.waiting, accept);
                        let no = ui.add_enabled(!st.waiting, egui::Button::new(tl!("Reject")).corner_radius(10).min_size(vec2(w, 32.0)));
                        elems.push(("assistant.accept".into(), ok.rect, "Accept".into()));
                        elems.push(("assistant.reject".into(), no.rect, "Reject".into()));
                        if ok.clicked() {
                            decision = Some(true);
                        }
                        if no.clicked() {
                            decision = Some(false);
                        }
                    });
                });
                elems.push(("assistant.pending".into(), card.response.rect, p.label.clone()));
            }
            // composer: an input that grows to six lines, with the send button inside
            let can_send = !st.waiting && !st.draft.trim().is_empty();
            egui::Frame::new()
                .fill(v.extreme_bg_color)
                .stroke(if focused { egui::Stroke::new(1.0, accent) } else { v.widgets.inactive.bg_stroke })
                .corner_radius(RADIUS)
                .inner_margin(egui::Margin { left: 12, right: 6, top: 6, bottom: 6 })
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        let send_w = 32.0;
                        let input_w = (ui.available_width() - send_w - ui.spacing().item_spacing.x).max(40.0);
                        egui::ScrollArea::vertical()
                            .id_salt("assistant-input-scroll")
                            .min_scrolled_height(LINE)
                            .max_height(MAX_INPUT_LINES * LINE + 12.0)
                            .show(ui, |ui| {
                                let edit = egui::TextEdit::multiline(&mut st.draft)
                                    .id(edit_id)
                                    .frame(egui::Frame::NONE)
                                    .font(egui::FontId::proportional(BODY))
                                    .desired_rows(1)
                                    .desired_width(input_w)
                                    .margin(egui::Margin::symmetric(0, 6))
                                    .hint_text(tl!("Ask for an edit…"));
                                let r = ui.add(edit);
                                elems.push(("assistant.input".into(), r.rect, "Message".into()));
                            });
                        let fill = if can_send { accent } else { v.widgets.inactive.weak_bg_fill };
                        let arrow = RichText::new("↑").size(17.0).strong().color(if can_send { on_accent } else { weak });
                        let b = ui.add_enabled(can_send, egui::Button::new(arrow).fill(fill).corner_radius(255).min_size(vec2(send_w, send_w)));
                        elems.push(("assistant.send".into(), b.rect, "Send".into()));
                        do_send |= b.clicked();
                    });
                });
        });
    // conversation (fills the rest, newest at the bottom; follows new messages unless scrolled up)
    egui::CentralPanel::no_frame().show(ui, |ui| {
        egui::ScrollArea::vertical().id_salt("assistant-conversation").auto_shrink([false, false]).stick_to_bottom(true).show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 4.0;
            let max_w = (ui.available_width() * 0.85).min(560.0);
            if st.messages.is_empty() && !st.thinking() {
                ui.add_space((ui.available_height() * 0.18).max(8.0));
                ui.vertical_centered(|ui| {
                    ui.label(RichText::new(tl!("Edit by chatting")).size(18.0).strong().color(text));
                    ui.add(egui::Label::new(RichText::new(tl!("Describe a change; you preview it before it lands.")).color(weak)).wrap());
                });
                ui.add_space(14.0);
                ui.spacing_mut().item_spacing.y = 8.0;
                for (i, s) in SUGGESTIONS.iter().enumerate() {
                    let b = egui::Button::new(body(crate::i18n::t(s)).color(text))
                        .fill(surface)
                        .stroke(v.widgets.noninteractive.bg_stroke)
                        .corner_radius(RADIUS)
                        .wrap()
                        .min_size(vec2(ui.available_width(), 38.0));
                    let r = ui.add_enabled(!st.waiting, b);
                    elems.push((format!("assistant.suggestion.{i}"), r.rect, (*s).to_string()));
                    if r.clicked() {
                        suggestion = Some(*s);
                    }
                }
            }
            let mut prev: Option<&str> = None;
            for (i, m) in st.messages.iter().enumerate() {
                let user = m.role == "user";
                let align = if user { egui::Align::Max } else { egui::Align::Min };
                ui.with_layout(egui::Layout::top_down(align), |ui| {
                    if prev != Some(m.role.as_str()) {
                        ui.add_space(if prev.is_some() { 10.0 } else { 0.0 });
                        ui.label(RichText::new(if user { tl!("You") } else { tl!("Assistant") }).small().color(weak));
                    }
                    let fill = if user { accent.gamma_multiply(0.28) } else { surface };
                    let r = egui::Frame::new().fill(fill).corner_radius(bubble_radius(user)).inner_margin(egui::Margin::symmetric(12, 8)).show(ui, |ui| {
                        ui.set_max_width(max_w);
                        ui.add(egui::Label::new(body(&m.text).color(text)).wrap().selectable(true))
                    });
                    elems.push((format!("assistant.message.{i}"), r.response.rect, m.role.clone()));
                });
                prev = Some(m.role.as_str());
            }
            if st.thinking() {
                ui.add_space(10.0);
                let r = egui::Frame::new().fill(surface).corner_radius(bubble_radius(false)).inner_margin(egui::Margin::symmetric(12, 8)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.add(egui::Spinner::new().size(12.0).color(weak));
                        ui.label(body(tl!("Thinking…")).color(weak));
                    });
                });
                elems.push(("assistant.thinking".into(), r.response.rect, "Thinking…".into()));
            }
            ui.add_space(4.0);
        });
    });
    for (id, r, label) in elems {
        app.auto.add(&id, r, &label);
    }
    let result = if let Some(s) = suggestion {
        send(app, &ctx, s)
    } else if do_send {
        let text = app.ui.assistant.draft.clone();
        if text.trim().is_empty() { Ok(Value::Null) } else { send(app, &ctx, &text) }
    } else if let Some(accept) = decision {
        decide(app, &ctx, accept)
    } else {
        Ok(Value::Null)
    };
    if let Err(e) = result {
        app.ui.assistant.error = Some(e);
    }
}

/// A minimal HTTP/1.1 client for the loopback service: no TLS, `Connection: close`, capped
/// answers, Content-Length or chunked bodies.
#[cfg(not(target_arch = "wasm32"))]
pub mod http {
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    use std::time::Duration;

    use serde_json::Value;

    pub const DEFAULT_URL: &str = "http://127.0.0.1:8793";
    pub const MAX_RESPONSE: usize = 1 << 20;
    const CONNECT: Duration = Duration::from_secs(2);
    const READ: Duration = Duration::from_secs(120);

    /// The service address from a base URL: `http://host[:port][/]`, loopback hosts only.
    pub fn parse_base(url: &str) -> Result<SocketAddr, String> {
        let bad = || format!("SHWAY_ASSISTANT_URL `{url}` must look like http://127.0.0.1:8793");
        let rest = url.trim().strip_prefix("http://").ok_or_else(bad)?;
        let authority = rest.strip_suffix('/').unwrap_or(rest);
        if authority.is_empty() || authority.contains(['/', '@', '?', '#']) {
            return Err(bad());
        }
        let localhost = |port: u16| SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let addr = if authority.eq_ignore_ascii_case("localhost") {
            localhost(80)
        } else if let Some(port) = authority.strip_prefix("localhost:") {
            localhost(port.parse().map_err(|_| bad())?)
        } else if let Ok(a) = authority.parse::<SocketAddr>() {
            a
        } else {
            SocketAddr::new(authority.parse::<IpAddr>().map_err(|_| bad())?, 80)
        };
        if !addr.ip().is_loopback() {
            return Err(format!("SHWAY_ASSISTANT_URL `{url}` is not a loopback address; the assistant only talks to this computer"));
        }
        Ok(addr)
    }

    /// One request to the service named by `SHWAY_ASSISTANT_URL`.
    pub fn call(method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let url = std::env::var("SHWAY_ASSISTANT_URL").unwrap_or_else(|_| DEFAULT_URL.into());
        request(parse_base(&url)?, method, path, body)
    }

    pub fn request(addr: SocketAddr, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let body = body.map(Value::to_string).unwrap_or_default();
        let mut s = TcpStream::connect_timeout(&addr, CONNECT).map_err(|_| super::NOT_RUNNING.to_string())?;
        let io = |e: std::io::Error| match e.kind() {
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => "The assistant did not answer in time".to_string(),
            _ => format!("Lost the connection to the assistant service: {e}"),
        };
        s.set_read_timeout(Some(READ)).map_err(io)?;
        s.set_write_timeout(Some(READ)).map_err(io)?;
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        s.write_all(head.as_bytes()).and_then(|_| s.write_all(body.as_bytes())).map_err(io)?;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = s.read(&mut chunk).map_err(io)?;
            let read = chunk.get(..n).unwrap_or_default();
            if buf.len().saturating_add(read.len()) > MAX_RESPONSE {
                return Err("The assistant's answer is too large".into());
            }
            buf.extend_from_slice(read);
            if let Some(r) = parse_response(&buf, n == 0)? {
                return into_json(r);
            }
        }
    }

    pub struct Response {
        pub status: u16,
        pub body: Vec<u8>,
    }

    /// A 2xx answer's JSON, or the service's `{"error"}` for any other status.
    pub fn into_json(r: Response) -> Result<Value, String> {
        let v: Result<Value, _> = serde_json::from_slice(&r.body);
        if (200..300).contains(&r.status) {
            return v.map_err(|_| "The assistant service sent malformed JSON".into());
        }
        match v.ok().as_ref().and_then(|v| v.get("error")).and_then(Value::as_str) {
            Some(e) => Err(format!("Assistant: {e}")),
            None => Err(format!("The assistant service answered HTTP {}", r.status)),
        }
    }

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    /// Parse a response from `buf`. `Ok(None)`: incomplete, read more (never when `eof`).
    pub fn parse_response(buf: &[u8], eof: bool) -> Result<Option<Response>, String> {
        let malformed = |what: &str| format!("The assistant service sent a malformed answer ({what})");
        let Some(end) = find(buf, b"\r\n\r\n") else {
            return if eof || buf.len() > 64 * 1024 { Err(malformed("headers")) } else { Ok(None) };
        };
        let head = std::str::from_utf8(buf.get(..end).unwrap_or_default()).map_err(|_| malformed("headers"))?;
        let rest = buf.get(end + 4..).unwrap_or_default();
        let mut lines = head.split("\r\n");
        let status_line = lines.next().unwrap_or_default();
        let mut parts = status_line.split(' ');
        if !parts.next().is_some_and(|v| v.starts_with("HTTP/1.")) {
            return Err(malformed("status line"));
        }
        let status: u16 = parts.next().and_then(|s| s.parse().ok()).filter(|s| (100..600).contains(s)).ok_or_else(|| malformed("status"))?;
        let mut length = None;
        let mut chunked = false;
        for line in lines {
            let (k, v) = line.split_once(':').ok_or_else(|| malformed("header"))?;
            let v = v.trim();
            if k.eq_ignore_ascii_case("content-length") {
                length = Some(v.parse::<usize>().map_err(|_| malformed("Content-Length"))?);
            } else if k.eq_ignore_ascii_case("transfer-encoding") {
                chunked = v.eq_ignore_ascii_case("chunked");
                if !chunked {
                    return Err(malformed("Transfer-Encoding"));
                }
            }
        }
        let body = if chunked {
            match dechunk(rest).map_err(malformed)? {
                Some(b) => b,
                None if eof => return Err(malformed("truncated")),
                None => return Ok(None),
            }
        } else if let Some(n) = length {
            if n > MAX_RESPONSE {
                return Err("The assistant's answer is too large".into());
            }
            match rest.get(..n) {
                Some(b) => b.to_vec(),
                None if eof => return Err(malformed("truncated")),
                None => return Ok(None),
            }
        } else if eof {
            rest.to_vec()
        } else {
            return Ok(None);
        };
        Ok(Some(Response { status, body }))
    }

    /// A chunked body; `Ok(None)` while incomplete.
    fn dechunk(mut data: &[u8]) -> Result<Option<Vec<u8>>, &'static str> {
        let mut out = Vec::new();
        loop {
            let Some(eol) = find(data, b"\r\n") else { return Ok(None) };
            let line = std::str::from_utf8(data.get(..eol).unwrap_or_default()).map_err(|_| "chunk size")?;
            let hex = line.split(';').next().unwrap_or_default().trim();
            let size = usize::from_str_radix(hex, 16).map_err(|_| "chunk size")?;
            if size > MAX_RESPONSE || out.len().saturating_add(size) > MAX_RESPONSE {
                return Err("chunk size");
            }
            data = data.get(eol + 2..).unwrap_or_default();
            if size == 0 {
                return Ok(Some(out)); // trailers, if any, are ignored
            }
            let Some(chunk) = data.get(..size) else { return Ok(None) };
            out.extend_from_slice(chunk);
            data = data.get(size..).unwrap_or_default();
            match data.get(..2) {
                Some(b"\r\n") => data = data.get(2..).unwrap_or_default(),
                Some(_) => return Err("chunk end"),
                None => return Ok(None),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::http::*;
    use super::*;

    fn parse(s: &str) -> Result<Option<Response>, String> {
        parse_response(s.as_bytes(), true)
    }

    #[test]
    fn content_length_bodies_parse() {
        let r = parse("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"busy\":1}\nextra").unwrap().unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"{\"busy\":1}\n");
        // incomplete until the whole body is in
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab", false).unwrap().is_none());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab", true).is_err());
    }

    #[test]
    fn chunked_bodies_parse() {
        let r = parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3;x=y\r\n:1}\r\n0\r\n\r\n").unwrap().unwrap();
        assert_eq!(into_json(r).unwrap(), json!({"a": 1}));
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a", false).unwrap().is_none());
        assert!(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n").is_err());
        assert!(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nabcd\r\n0\r\n\r\n").is_err());
        assert!(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n").is_err());
    }

    #[test]
    fn oversized_answers_are_refused() {
        assert!(parse(&format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_RESPONSE + 1)).is_err());
        assert!(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nFFFFFFFFFFFFFFFF\r\n").is_err());
        assert!(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n200000\r\n").is_err());
        assert!(parse_response(&vec![b'a'; 70 * 1024], false).is_err());
    }

    #[test]
    fn malformed_answers_never_panic() {
        for s in [
            "",
            "garbage\r\n\r\n",
            "HTTP/1.1\r\n\r\n",
            "HTTP/1.1 abc OK\r\n\r\n",
            "HTTP/1.1 999 X\r\n\r\n",
            "HTTP/1.1 200 OK\r\nNoColon\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n",
        ] {
            assert!(parse(s).is_err(), "{s:?}");
        }
        // every truncation and byte flip of a real answer: an error or a parse, never a panic
        let good = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n".to_vec();
        for n in 0..good.len() {
            let _ = parse_response(good.get(..n).unwrap(), true);
            let _ = parse_response(good.get(..n).unwrap(), false);
            let mut bad = good.clone();
            bad[n] ^= 0xff;
            let _ = parse_response(&bad, true).map(|r| r.map(into_json));
        }
        // 2xx with a body that isn't JSON
        assert!(into_json(parse("HTTP/1.1 200 OK\r\n\r\nnot json").unwrap().unwrap()).is_err());
    }

    #[test]
    fn errors_carry_the_service_message() {
        let r = parse("HTTP/1.1 400 Bad Request\r\nContent-Length: 26\r\n\r\n{\"error\":\"message is empty\"}").unwrap();
        // Content-Length shorter than the body: only that much is read
        assert!(into_json(r.unwrap()).is_err());
        let r = parse("HTTP/1.1 409 Conflict\r\nContent-Length: 28\r\n\r\n{\"error\":\"message is empty\"}").unwrap().unwrap();
        assert_eq!(into_json(r).unwrap_err(), "Assistant: message is empty");
        let r = parse("HTTP/1.1 500 Oops\r\n\r\n<html>").unwrap().unwrap();
        assert_eq!(into_json(r).unwrap_err(), "The assistant service answered HTTP 500");
    }

    #[test]
    fn only_loopback_bases_are_accepted() {
        assert_eq!(parse_base("http://127.0.0.1:8793").unwrap().port(), 8793);
        assert_eq!(parse_base("http://localhost:9000/").unwrap().to_string(), "127.0.0.1:9000");
        assert_eq!(parse_base("http://[::1]:8793").unwrap().port(), 8793);
        for bad in [
            "https://127.0.0.1:8793",
            "http://10.0.0.2:8793",
            "http://example.com",
            "http://127.0.0.1:8793/x",
            "http://u@127.0.0.1",
            "127.0.0.1:8793",
            "http://",
            "http://127.0.0.1:99999",
        ] {
            assert!(parse_base(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn state_transitions() {
        let mut s = AssistantUi { draft: "  cut the ums ".into(), ..Default::default() };
        assert_eq!(s.begin_send(&s.draft.clone()).unwrap(), "cut the ums");
        assert!(s.waiting && s.thinking() && s.draft.is_empty());
        assert_eq!(s.messages, vec![Message { role: "user".into(), text: "cut the ums".into() }]);
        assert!(s.begin_send("again").is_err(), "one request at a time");
        assert!(s.begin_decision().is_err());
        s.apply_reply(Ok(ChatReply { reply: "Previewing 3 cuts".into(), pending: Some(Pending { token: 7, label: "Remove 3 ums".into() }), busy: false }));
        assert!(!s.waiting && !s.thinking());
        assert_eq!(s.messages.len(), 2);
        assert_eq!(s.pending.as_ref().map(|p| p.token), Some(7));
        s.begin_decision().unwrap();
        s.apply_reply(Err(NOT_RUNNING.into()));
        assert!(!s.waiting);
        assert_eq!(s.error.as_deref(), Some(NOT_RUNNING));
        assert!(s.pending.is_some(), "a failed accept keeps the proposal");
        s.apply_state(Ok(ChatState { messages: vec![], pending: None, busy: true }));
        assert!(s.error.is_none() && s.pending.is_none() && s.thinking());
        assert!(s.begin_decision().is_err(), "nothing to accept");
        assert!(s.begin_send("   ").is_err());
        assert!(s.begin_send(&"x".repeat(MAX_MESSAGE + 1)).is_err());
        assert!(s.begin_send(&"é".repeat(MAX_MESSAGE)).is_ok());
    }

    #[test]
    fn round_trip_with_a_fake_service() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = Vec::new();
            let mut b = [0u8; 4096];
            while !req.windows(4).any(|w| w == b"\r\n\r\n") || !req.ends_with(b"}") {
                let n = s.read(&mut b).unwrap();
                req.extend_from_slice(&b[..n]);
            }
            let reply = r#"{"reply":"Done","pending":{"token":3,"label":"Trim intro"},"busy":false}"#;
            // chunked, in two writes
            let (a, z) = reply.split_at(10);
            write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{a}\r\n", a.len()).unwrap();
            s.flush().unwrap();
            write!(s, "{:x}\r\n{z}\r\n0\r\n\r\n", z.len()).unwrap();
            String::from_utf8(req).unwrap()
        });
        let v = request(addr, "POST", "/chat", Some(&json!({"message": "trim the intro"}))).unwrap();
        let reply: ChatReply = decode(Ok(v)).unwrap();
        assert_eq!(reply.reply, "Done");
        assert_eq!(reply.pending, Some(Pending { token: 3, label: "Trim intro".into() }));
        let req = server.join().unwrap();
        assert!(req.starts_with("POST /chat HTTP/1.1\r\n"), "{req}");
        assert!(req.ends_with("\r\n\r\n{\"message\":\"trim the intro\"}"), "{req}");
    }

    #[test]
    fn a_closed_port_says_the_service_is_not_running() {
        let addr = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap(); // dropped: nothing listens
        assert_eq!(request(addr, "GET", "/chat/state", None).unwrap_err(), NOT_RUNNING);
    }
}
