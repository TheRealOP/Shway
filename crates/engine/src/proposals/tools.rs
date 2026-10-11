//! Explicit-target, bounded subset of ordinary editing commands. Registry descriptions are
//! documentation, not executable schemas; this boundary is authoritative for model input.
use super::*;
use filmcraft_project::{EffectKind, ParamKind, ParamValue};

pub(super) const TOOLS: &[(&str, &[&str])] = &[
    ("clip.rename", &["name"]),
    ("clip.enable", &[]),
    ("clip.link", &[]),
    ("clip.group", &[]),
    ("clip.ungroup", &[]),
    ("clip.scaleToFrameSize", &[]),
    ("clip.fitToFrame", &[]),
    ("clip.fillFrame", &[]),
    ("clip.timeInterpolation.frameSampling", &[]),
    ("clip.timeInterpolation.frameBlending", &[]),
    ("clip.timeInterpolation.opticalFlow", &[]),
    ("clip.setTimeInterpolation", &["mode"]),
    ("clip.volumeUp", &[]),
    ("clip.volumeDown", &[]),
    ("clip.nudgeVolumeUp1", &[]),
    ("clip.nudgeVolumeUp3", &[]),
    ("clip.nudgeVolumeDown1", &[]),
    ("clip.nudgeVolumeDown3", &[]),
    ("clip.speedDuration", &["speed", "reverse", "ripple", "interpolation"]),
    ("clip.audioGain", &["mode", "db", "relative"]),
    ("clip.frameHold", &["time"]),
    ("clip.fieldOptions", &["reverseFieldDominance", "processing"]),
    ("clip.frameHoldOptions", &["enabled", "holdOn", "time", "holdFilters"]),
    ("captions.add", &["text"]),
    ("edit.removeAttributes", &["motion", "opacity", "timeRemapping", "volume", "channelVolume", "panner", "effects"]),
    ("timeline.razor", &["time"]),
    ("timeline.slip", &["deltaFrames"]),
    ("timeline.slide", &["deltaFrames"]),
    ("timeline.roll", &["deltaFrames"]),
    ("timeline.rateStretch", &["edge", "deltaFrames"]),
    ("timeline.nudgeLeft", &[]),
    ("timeline.nudgeRight", &[]),
    ("timeline.nudgeLeft5", &[]),
    ("timeline.nudgeRight5", &[]),
    ("timeline.nudgeUp", &[]),
    ("timeline.nudgeDown", &[]),
    ("timeline.slipLeft", &[]),
    ("timeline.slipRight", &[]),
    ("timeline.slipLeft5", &[]),
    ("timeline.slipRight5", &[]),
    ("timeline.slideLeft", &[]),
    ("timeline.slideRight", &[]),
    ("timeline.slideLeft5", &[]),
    ("timeline.slideRight5", &[]),
    ("effects.apply", &["effect"]),
    ("effects.remove", &["index"]),
    ("effects.toggleEnabled", &["index"]),
    ("effects.reset", &["index"]),
    ("effects.setParam", &["effect", "param", "value", "time"]),
    ("effects.toggleAnimation", &["effect", "param"]),
    ("effects.addKeyframe", &["effect", "param", "time"]),
    ("effects.deleteKeyframe", &["effect", "param", "mediaTime"]),
    ("effects.moveKeyframe", &["effect", "param", "mediaTime", "to"]),
    ("effects.setInterpolation", &["effect", "param", "mediaTime", "interpolation"]),
    ("effects.setKeyframe", &["effect", "param", "mediaTime", "value", "inInfluence", "outInfluence"]),
    ("essentialSound.setType", &["type"]),
    ("essentialSound.clearType", &[]),
    ("graphics.newText", &["text", "size", "position"]),
    ("graphics.newShape", &["shape", "size", "position"]),
    ("graphics.setText", &["layer", "text"]),
    ("graphics.deleteLayer", &["layer"]),
    ("graphics.setTextType", &["layer", "type"]),
];

pub(crate) fn catalog(s: &Session) -> Value {
    let specs = crate::commands::command_specs();
    let tools: Vec<_> = TOOLS
        .iter()
        .filter_map(|(id, args)| {
            crate::commands::find(id).map(|c| {
                json!({
                    "id":id,"label":c.label,"params":c.params,"args":args,"available":(c.enabled)(s).is_ok(),
                    "targets":if *id == "timeline.roll" {"two clips, left then right"} else {"explicit clips; effect/graphic parameter edits need one"}
                })
            })
        })
        .collect();
    let core_total = specs.iter().filter(|c| c.journal && ["clip.", "timeline.", "effects."].iter().any(|prefix| c.id.starts_with(prefix))).count();
    // Keep unsupported specialized project edits in the denominator. Exclude only state,
    // preferences and external file writes; publish each exclusion so coverage is auditable.
    let excluded: Vec<_> = specs
        .iter()
        .filter(|c| c.journal && ["clip.", "timeline.", "effects."].iter().any(|p| c.id.starts_with(p)))
        .filter(|c| {
            c.id.starts_with("timeline.select")
                || c.id.starts_with("timeline.toggleTarget")
                || c.id.starts_with("timeline.toggleAll")
                || c.id.starts_with("timeline.moveVideoTargets")
                || c.id.starts_with("timeline.moveAudioTargets")
                || matches!(c.id, "timeline.setTargeting" | "clip.revealInProject" | "effects.setDefaultTransition" | "clip.extractAudio")
        })
        .map(|c| c.id)
        .collect();
    let core_supported =
        tools.iter().filter(|t| t["id"].as_str().is_some_and(|id| ["clip.", "timeline.", "effects."].iter().any(|p| id.starts_with(p)))).count() + 4; // existing trim/move/place/replace preview steps
    let effects: Vec<_> = filmcraft_project::effect_defs()
        .iter()
        .filter(|d| !d.intrinsic && matches!(d.kind, EffectKind::Video | EffectKind::Audio) && !filmcraft_project::graphic::is_layer_id(d.id))
        .map(|d| json!({"id":d.id,"name":d.name,"kind":d.kind,"params":d.params.iter().map(|p|json!({"id":p.id,"kind":p.kind})).collect::<Vec<_>>()}))
        .collect();
    json!({"tools":tools,"supported":tools.len(),"coreSupported":core_supported,"coreRegisteredCommands":core_total,"coreRegisteredEditingCommands":core_total - excluded.len(),"coverageExcluded":excluded,"effects":effects,"applicableEffects":effects.len(),
        "limits":"16 steps, 32 target references; no files/jobs/settings; bounded scalars, strings and points only; effect definitions supply type/range validation"})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Tool {
    id: String,
    clips: Vec<u64>,
    args: Value,
}

fn scalar(v: &Value) -> bool {
    match v {
        Value::Bool(_) => true,
        Value::String(s) => s.len() <= 2000,
        Value::Number(n) => n.as_f64().is_some_and(|n| n.is_finite() && n.abs() <= 1_000_000.0),
        Value::Array(a) => {
            a.len() <= 16 && a.iter().all(|v| matches!(v, Value::Number(n) if n.as_f64().is_some_and(|n| n.is_finite() && n.abs() <= 1_000_000.0)))
        }
        _ => false,
    }
}

fn value_for(def: &filmcraft_project::ParamDef, v: &Value) -> Result<Value> {
    let val = match (&def.kind, v) {
        (ParamKind::Choice(options), Value::String(name)) => {
            let index = options.iter().position(|o| o.eq_ignore_ascii_case(name)).ok_or_else(|| bad("unknown parameter choice"))?;
            return Ok(json!(index));
        }
        _ => crate::commands::json_to_param(&def.default, v).ok_or_else(|| bad("wrong effect parameter type"))?,
    };
    let valid = match (&def.kind, &val) {
        (ParamKind::Float { min, max, .. }, ParamValue::Float(n)) => n.is_finite() && n >= min && n <= max,
        (ParamKind::Choice(options), ParamValue::Choice(n)) => (*n as usize) < options.len(),
        (ParamKind::Angle, ParamValue::Float(n)) => n.is_finite() && n.abs() <= 3600.0,
        (ParamKind::Point | ParamKind::Wheel, ParamValue::Vec2(p)) => p.x.is_finite() && p.y.is_finite() && p.x.abs() <= 100_000.0 && p.y.abs() <= 100_000.0,
        (ParamKind::Bool, ParamValue::Bool(_)) | (ParamKind::Text, ParamValue::Text(_)) | (ParamKind::Color, ParamValue::Color(_)) => true,
        _ => false, // Curves and paths require a separate bounded schema.
    };
    if !valid {
        return Err(bad("effect parameter exceeds its supported type/range"));
    }
    Ok(v.clone())
}

pub(super) fn apply_tool(s: &mut Session, p: Tool) -> Result<Value> {
    let (_, fields) = TOOLS.iter().find(|(id, _)| *id == p.id).ok_or_else(|| bad("command is not approved for project previews"))?;
    let args = p.args.as_object().ok_or_else(|| bad("tool args must be an object"))?;
    if args.len() > 12
        || args.iter().any(|(k, v)| {
            !fields.contains(&k.as_str())
                || !(scalar(v) || ["time", "mediaTime", "to"].contains(&k.as_str()) && v.as_i64().is_some_and(|n| n >= 0 && n <= MAX_INTEGER as i64))
        })
    {
        return Err(bad("unsupported tool argument or unbounded value"));
    }
    if p.clips.is_empty() || p.clips.len() > MAX_TARGETS {
        return Err(bad("tool needs 1–32 explicit clips"));
    }
    let mut seen = BTreeSet::new();
    let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
    for c in &p.clips {
        id(*c)?;
        if !seen.insert(*c) {
            return Err(bad("duplicate tool target"));
        }
        let (t, clip) = q.find_item(ClipId(*c)).ok_or_else(|| bad("missing tool clip"))?;
        if q.track(t).is_none_or(|t| t.locked) {
            return Err(bad("tool target is locked"));
        }
        tick(clip.start.0)?;
        tick(clip.duration.0)?;
        tick(clip.source_in.0)?;
        if clip.duration <= Tick::ZERO || !clip.speed.is_finite() || clip.speed <= 0.0 {
            return Err(bad("invalid tool clip timing"));
        }
    }
    let mut params = p.args.clone();
    let single =
        p.id.starts_with("effects.") && p.id != "effects.apply" || p.id.starts_with("graphics.") || p.id.starts_with("timeline.") || p.id == "clip.rename";
    if single && p.id != "timeline.roll" && p.clips.len() != 1 {
        return Err(bad("this tool requires one explicit clip"));
    }
    params["clips"] = json!(p.clips);
    params["clip"] = json!(p.clips.first());
    for (key, v) in args {
        match key.as_str() {
            "time" | "mediaTime" | "to" => {
                let n = v.as_i64().ok_or_else(|| bad("tool time must be exact ticks"))?;
                tick(n)?;
                if n < 0 || n > q.duration().0.max(clip_source_limit(s, *p.clips.first().ok_or_else(|| bad("missing target"))?)?) {
                    return Err(bad("tool time outside project/source range"));
                }
            }
            "deltaFrames" => {
                let n = v.as_i64().ok_or_else(|| bad("frame delta must be integer"))?;
                if n == 0 || n.unsigned_abs() > 10_000 {
                    return Err(bad("frame delta must be nonzero within ±10000"));
                }
                params["delta"] = json!(n.checked_mul(frame_ticks(s)?).ok_or_else(|| bad("frame delta overflow"))?);
                params.as_object_mut().ok_or_else(|| bad("invalid params"))?.remove("deltaFrames");
            }
            "speed" if !v.as_f64().is_some_and(|n| (6.25..=1600.0).contains(&n)) => return Err(bad("speed must be 6.25–1600 percent")),
            "db" if !v.as_f64().is_some_and(|n| (-96.0..=24.0).contains(&n)) => return Err(bad("gain must be -96–24 dB")),
            "reverse"
            | "ripple"
            | "relative"
            | "reverseFieldDominance"
            | "enabled"
            | "holdFilters"
            | "motion"
            | "opacity"
            | "timeRemapping"
            | "volume"
            | "channelVolume"
            | "panner"
            | "effects"
                if !v.is_boolean() =>
            {
                return Err(bad("expected boolean"));
            }
            "index" | "layer" if !v.as_u64().is_some_and(|n| n <= 1024) => return Err(bad("effect/layer index must be 0–1024")),
            "inInfluence" | "outInfluence" if !v.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)) => return Err(bad("influence must be 0–1")),
            _ => {}
        }
    }
    if p.id == "timeline.roll" {
        if p.clips.len() != 2 {
            return Err(bad("roll requires left and right clips"));
        }
        params["left"] = json!(*p.clips.first().ok_or_else(|| bad("missing target"))?);
        params["right"] = json!(p.clips.get(1).ok_or_else(|| bad("missing right target"))?);
    }
    if p.id == "timeline.razor" && !args.contains_key("time") {
        return Err(bad("razor requires explicit time"));
    }
    if matches!(p.id.as_str(), "timeline.roll" | "timeline.slip" | "timeline.slide" | "timeline.rateStretch") && !args.contains_key("deltaFrames") {
        return Err(bad("timeline adjustment requires explicit deltaFrames"));
    }
    if p.id == "timeline.rateStretch" && !args.get("edge").is_some_and(|v| v == "in" || v == "out") {
        return Err(bad("rate stretch edge must be in/out"));
    }
    if p.id == "clip.audioGain" && (!args.contains_key("db") || !args.get("mode").is_some_and(|v| v == "set" || v == "adjust")) {
        return Err(bad("gain requires db and set/adjust mode"));
    }
    if args.get("position").is_some_and(|v| !v.as_array().is_some_and(|a| a.len() == 2)) {
        return Err(bad("position must be a point"));
    }
    if p.id == "clip.fieldOptions" && args.get("processing").is_some_and(|v| v != "none" && v != "alwaysDeinterlace" && v != "flickerRemoval") {
        return Err(bad("unknown field processing"));
    }
    if p.id == "clip.setTimeInterpolation" && !args.get("mode").is_some_and(|v| ["frameSampling", "frameBlending", "opticalFlow"].iter().any(|m| v == m)) {
        return Err(bad("unknown time interpolation"));
    }
    if p.id == "clip.frameHoldOptions" && args.get("holdOn").is_some_and(|v| !["sequenceTime", "in", "out", "playhead"].iter().any(|o| v == o)) {
        return Err(bad("unsupported hold mode"));
    }
    if p.id == "effects.setInterpolation"
        && !args
            .get("interpolation")
            .is_some_and(|v| ["linear", "bezier", "autoBezier", "continuousBezier", "hold", "easeIn", "easeOut"].iter().any(|o| v == o))
    {
        return Err(bad("unknown keyframe interpolation"));
    }
    if p.id == "effects.apply" {
        let eid = args.get("effect").and_then(Value::as_str).ok_or_else(|| bad("effect id required"))?;
        let def = filmcraft_project::find_effect(eid).ok_or_else(|| bad("unknown effect id"))?;
        if def.intrinsic || !matches!(def.kind, EffectKind::Video | EffectKind::Audio) || filmcraft_project::graphic::is_layer_id(eid) {
            return Err(bad("apply only ordinary video/audio effects; transitions use the transition step"));
        }
    }
    if p.id.starts_with("effects.") && args.contains_key("param") {
        let eid = args.get("effect").and_then(Value::as_str).ok_or_else(|| bad("explicit effect id required"))?;
        let name = args.get("param").and_then(Value::as_str).ok_or_else(|| bad("parameter id required"))?;
        let def = filmcraft_project::find_effect(eid).and_then(|e| e.param(name)).ok_or_else(|| bad("unknown effect parameter"))?;
        if let Some(v) = args.get("value") {
            params["value"] = value_for(def, v)?;
        }
    }
    if p.id == "graphics.newText" || p.id == "graphics.newShape" || p.id == "captions.add" {
        let clip = q.find_item(ClipId(*p.clips.first().ok_or_else(|| bad("missing graphic anchor"))?)).ok_or_else(|| bad("missing graphic anchor"))?.1;
        if clip.duration.0 > 60 * TICKS_PER_SECOND {
            return Err(bad("graphic anchor must be at most 60 seconds"));
        }
        params["time"] = json!(clip.start.0);
        params["seconds"] = json!(clip.duration.0 as f64 / TICKS_PER_SECOND as f64);
        params["durationSeconds"] = params["seconds"].clone();
        if p.id == "graphics.newText" && !args.get("text").is_some_and(Value::is_string) {
            return Err(bad("new text requires text"));
        }
        if p.id == "graphics.newShape" && !args.get("shape").is_some_and(|v| v == "rectangle" || v == "ellipse") {
            return Err(bad("new shape must be rectangle or ellipse"));
        }
        if args.get("size").is_some_and(|v| match v {
            Value::Number(n) => !n.as_f64().is_some_and(|n| n > 0.0 && n <= 1000.0),
            Value::Array(a) => a.len() != 2 || !a.iter().all(|v| v.as_f64().is_some_and(|n| n > 0.0 && n <= 10000.0)),
            _ => true,
        }) {
            return Err(bad("invalid graphic size"));
        }
    }
    // Selection-dependent commands operate only on these targets, including validated linked partners.
    let expanded = crate::commands::with_links(s, &p.clips.iter().copied().map(ClipId).collect::<Vec<_>>());
    if expanded.len() > MAX_TARGETS {
        return Err(bad("too many linked tool targets"));
    }
    if p.id == "effects.apply" {
        params["clips"] = json!(expanded.iter().map(|c| c.0).collect::<Vec<_>>());
    }
    for c in &expanded {
        let (t, _) = q.find_item(*c).ok_or_else(|| bad("missing linked target"))?;
        if q.track(t).is_none_or(|t| t.locked) {
            return Err(bad("linked tool target is locked"));
        }
    }
    let base = s.project.clone();
    s.state.selection = p.clips.iter().copied().map(ClipId).collect();
    let result = s.execute(&p.id, params)?;
    let after = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let before = base.sequence(s.state.active_sequence.ok_or(EngineError::NoSequence)?).ok_or(EngineError::NoSequence)?;
    if before.all_tracks().filter(|t| t.locked).any(|t| after.track(t.id) != Some(t)) {
        return Err(bad("tool changed a locked track"));
    }
    Ok(result)
}

fn clip_source_limit(s: &Session, id: u64) -> Result<i64> {
    let clip = s.active_sequence().and_then(|q| q.find_item(ClipId(id))).ok_or_else(|| bad("missing tool target"))?.1;
    Ok(s.project.item(clip.item).and_then(|i| i.as_media()).map_or(clip.duration.0, |m| m.info.duration.0))
}
