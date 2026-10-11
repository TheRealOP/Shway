//! DEV-91: the Shway ink overlay on the Program monitor, set through `ui.set {ink}`. Hostile
//! payloads (wrong types, out-of-range or non-finite points, huge arrays) must never fail the
//! call or panic the paint; the state stays within the caps and round-trips through serde.

use std::sync::mpsc::{Sender, channel};

use egui_kittest::Harness;
use filmcraft_engine::Session;
use filmcraft_ui_egui::FilmcraftApp;
use filmcraft_ui_egui::control::ControlRequest;
use filmcraft_ui_egui::state::Ink;
use serde_json::{Value, json};

struct Driver {
    harness: Harness<'static, FilmcraftApp>,
    tx: Sender<ControlRequest>,
}

impl Driver {
    fn demo() -> Self {
        let mut session = Session::default();
        session.execute("file.openDemoProject", json!({})).unwrap();
        let (tx, rx) = channel();
        let app = FilmcraftApp::new(session).with_control(rx);
        let harness = Harness::builder().with_size(egui::vec2(1600.0, 980.0)).with_max_steps(10_000).build_eframe(move |_cc| app);
        let mut d = Driver { harness, tx };
        d.harness.run_steps(4);
        d
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let (req, reply) = ControlRequest::new(method, params.clone());
        self.tx.send(req).unwrap();
        for _ in 0..600 {
            self.harness.step();
            if let Ok(v) = reply.try_recv() {
                return v;
            }
        }
        panic!("no reply to {method} {params}");
    }

    fn set_ink(&mut self, ink: Value) -> Ink {
        let r = self.call("ui.set", json!({ "ink": ink }));
        assert_eq!(r["ok"], true, "{ink}: {r}");
        self.harness.run_steps(2); // paint it
        let ui = self.call("ui.inspect", json!({}));
        serde_json::from_value(ui["result"]["ui"]["ink"].clone()).unwrap()
    }
}

#[test]
fn ink_set_paints_and_round_trips() {
    let mut d = Driver::demo();
    let ink = d.set_ink(json!({"pointer": [0.5, 0.5], "drawing": true, "scrub": true, "strokes": [[[0.2, 0.2], [0.5, 0.6], [0.8, 0.3]]]}));
    assert_eq!(ink, Ink { pointer: Some([0.5, 0.5]), drawing: true, scrub: true, strokes: vec![vec![[0.2, 0.2], [0.5, 0.6], [0.8, 0.3]]] });
    assert_eq!(serde_json::from_value::<Ink>(serde_json::to_value(&ink).unwrap()).unwrap(), ink);

    // absent keys are kept; a pointer update leaves the strokes alone
    let ink = d.set_ink(json!({"pointer": [0.1, 0.9], "drawing": false}));
    assert_eq!((ink.pointer, ink.drawing, ink.strokes.len()), (Some([0.1, 0.9]), false, 1));
    // null clears everything
    assert_eq!(d.set_ink(Value::Null), Ink::default());
}

#[test]
fn hostile_ink_payloads_are_dropped_not_errors() {
    let mut d = Driver::demo();
    // out of range, wrong arity, wrong types, f32 overflow (inf), all dropped point by point
    let ink = d.set_ink(json!({
        "pointer": [1.5, 0.5],
        "drawing": "yes",
        "strokes": [[[0.1, 0.1], [-0.1, 0.5], [0.5], [0.5, 0.5, 0.5], ["a", 0.2], null, [1e39, 0.5], [0.3, 0.3]], "nope", [], [[2, 2]]],
    }));
    assert_eq!(ink, Ink { pointer: None, drawing: false, scrub: false, strokes: vec![vec![[0.1, 0.1], [0.3, 0.3]]] });

    // `ink` that is not an object (or null) is ignored; fields of the wrong type clear that field
    let before = ink;
    for bad in [json!(5), json!("ink"), json!([1, 2])] {
        assert_eq!(d.set_ink(bad), before);
    }
    let ink = d.set_ink(json!({"strokes": 7, "pointer": {"x": 0.5}}));
    assert!(ink.strokes.is_empty() && ink.pointer.is_none(), "{ink:?}");

    // huge arrays are capped at 20 strokes x 500 points
    let stroke: Vec<[f64; 2]> = (0..5_000).map(|i| [(i % 100) as f64 / 100.0, 0.5]).collect();
    let ink = d.set_ink(json!({"strokes": vec![stroke; 200]}));
    assert_eq!(ink.strokes.len(), Ink::MAX_STROKES);
    assert!(ink.strokes.iter().all(|s| s.len() == Ink::MAX_POINTS));

    // the rest of ui.set still applies alongside a bad ink payload
    let r = d.call("ui.set", json!({"ink": {"strokes": [[[9, 9]]]}, "safeMargins": true}));
    assert_eq!(r["ok"], true, "{r}");
    let ui = d.call("ui.inspect", json!({}));
    assert_eq!(ui["result"]["ui"]["program"]["safe_margins"], true, "{}", ui["result"]["ui"]["program"]);
}
