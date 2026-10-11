use std::sync::Arc;

use filmcraft_project::{ClipId, ItemId};
use serde_json::{Value, json};

use crate::Session;

fn fixture() -> (Session, u64, u64, u64) {
    let mut s = Session::default();
    s.execute("file.openDemoProject", json!({})).unwrap();
    let q = s.active_sequence().unwrap();
    let first = q.video_tracks[0].items.first().unwrap();
    let ids = (first.id.0, first.item.0, q.audio_tracks[0].items.first().unwrap().id.0);
    (s, ids.0, ids.1, ids.2)
}

fn trim(s: &Session, clip: u64, source: u64) -> Value {
    json!({"expectedRevision":s.revision,"sequence":s.state.active_sequence.unwrap().0,"label":"Shorten opening take",
        "steps":[{"command":"timeline.trim","params":{"clip":clip,"source":source,"edge":"out","mode":"regular","deltaFrames":-1}}]})
}

fn run(s: &mut Session, params: Value) -> u64 {
    s.execute("proposal.preview", params).unwrap()["token"].as_u64().unwrap()
}

#[test]
fn candidate_is_unpublished_and_commit_undo_redo_is_one_step() {
    let (mut s, clip, source, audio) = fixture();
    // Proposals preserve A/V even when normal linked selection is disabled.
    s.state.linked_selection = false;
    let base = s.project.clone();
    let revision = s.revision;
    let undo = s.history.undo.len();
    let journal = s.journal.len();
    let params = trim(&s, clip, source);
    let token = run(&mut s, params);
    assert!(Arc::ptr_eq(&s.project, &base));
    assert_eq!(s.revision, revision);
    assert_eq!(s.history.undo.len(), undo);
    assert_eq!(s.journal.len(), journal);
    let candidate = s.execute("proposal.inspect", json!({"token":token})).unwrap();
    let q = s.active_sequence().unwrap();
    let original = q.find_item(ClipId(clip)).unwrap().1.duration.0;
    let duration = original - s.sequence_rate().frame_duration().0;
    assert_eq!(candidate["sequence"]["video"][0]["items"][0]["duration"], duration);
    assert_eq!(candidate["sequence"]["audio"][0]["items"][0]["duration"], duration);
    let render = s.execute("proposal.render", json!({"token":token,"frame":0,"maxSide":32})).unwrap();
    assert_eq!(render["width"], 32);
    assert!(!render["rgba"].as_array().unwrap().is_empty());
    assert!(Arc::ptr_eq(&s.project, &base));
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    assert_eq!(s.history.undo.len(), undo + 1);
    let committed = s.project.clone();
    for c in [clip, audio] {
        assert_eq!(s.active_sequence().unwrap().find_item(ClipId(c)).unwrap().1.duration.0, duration);
    }
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(*s.project, *base);
    s.execute("edit.redo", json!({})).unwrap();
    assert_eq!(*s.project, *committed);
    assert!(s.execute("proposal.commit", json!({"token":token})).is_err());
}

#[test]
fn cancel_preserves_redo_and_stale_cancel_preserves_newer_edits() {
    let (mut s, clip, source, _) = fixture();
    s.execute("timeline.trim", json!({"clip":clip,"deltaFrames":-2})).unwrap();
    s.execute("edit.undo", json!({})).unwrap();
    let redo = s.history.redo.clone();
    let base = s.project.clone();
    let params = trim(&s, clip, source);
    let token = run(&mut s, params);
    s.execute("proposal.cancel", json!({"token":token})).unwrap();
    assert!(Arc::ptr_eq(&s.project, &base));
    assert_eq!(s.history.redo, redo);
    let params = trim(&s, clip, source);
    let token = run(&mut s, params);
    s.execute("timeline.trim", json!({"clip":clip,"deltaFrames":-2})).unwrap();
    let newer = s.project.clone();
    let undo = s.history.undo.len();
    assert!(s.execute("proposal.commit", json!({"token":token})).is_err());
    s.execute("proposal.cancel", json!({"token":token})).unwrap();
    assert!(Arc::ptr_eq(&s.project, &newer));
    assert_eq!(s.history.undo.len(), undo);
}

#[test]
fn stale_context_and_revision_cannot_commit() {
    let (mut s, clip, source, _) = fixture();
    let mut stale = trim(&s, clip, source);
    stale["expectedRevision"] = json!(s.revision - 1);
    assert!(s.execute("proposal.preview", stale).is_err());
    let params = trim(&s, clip, source);
    let token = run(&mut s, params);
    let base = s.project.clone();
    s.execute("timeline.select", json!({"clips":[clip]})).unwrap();
    assert!(s.execute("proposal.commit", json!({"token":token})).is_err());
    assert!(Arc::ptr_eq(&s.project, &base));
    s.execute("proposal.cancel", json!({"token":token})).unwrap();
    let params = trim(&s, clip, source);
    let token = run(&mut s, params);
    // Seek does not invalidate proposals, and commit preserves the newer cursor.
    s.execute("playhead.set", json!({"frame":5})).unwrap();
    let time = s.playhead();
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    assert_eq!(s.playhead(), time);
}

#[test]
fn hostile_parameters_and_failed_second_step_leave_no_candidate_or_partial_edit() {
    let (mut s, clip, source, _) = fixture();
    let base = s.project.clone();
    let history = s.history.undo.clone();
    let good = trim(&s, clip, source);
    let mut cases = Vec::new();
    for (key, value) in [
        ("clip", json!(-1)),
        ("clip", json!(1.5)),
        ("clip", json!(0)),
        ("clip", json!(9_007_199_254_740_992u64)),
        ("source", json!(source + 999_999)),
        ("deltaFrames", json!(i64::MAX)),
        ("edge", json!("sideways")),
        ("mode", json!("roll")),
        ("deltaFrames", json!(0)),
        ("deltaFrames", json!(1e300)),
        ("surprise", json!(1)),
    ] {
        let mut p = good.clone();
        p["steps"][0]["params"][key] = value;
        cases.push(p);
    }
    let mut unsupported = good.clone();
    unsupported["steps"][0]["command"] = json!("file.save");
    cases.push(unsupported);
    let mut unknown = good.clone();
    unknown["surprise"] = json!(vec!["large ignored payload"; 1024]);
    cases.push(unknown);
    let mut oversized = good.clone();
    oversized["steps"] = json!(vec![good["steps"][0].clone(); 17]);
    cases.push(oversized);
    let mut second_failure = good.clone();
    let mut step = good["steps"][0].clone();
    step["params"]["clip"] = json!(999_999);
    second_failure["steps"].as_array_mut().unwrap().push(step);
    cases.push(second_failure);
    for p in cases {
        assert!(s.execute("proposal.preview", p).is_err());
        assert!(Arc::ptr_eq(&s.project, &base));
        assert_eq!(s.history.undo, history);
        assert!(s.proposal.is_none());
    }
}

#[test]
fn replacement_keeps_linked_av_and_rejects_short_media() {
    let (mut s, clip, source, audio) = fixture();
    let replacement = s.project.items.values().find(|i| i.id != ItemId(source) && i.as_media().is_some() && i.has_audio() && i.has_video()).unwrap().id;
    let request = |s: &Session| {
        json!({"sequence":s.state.active_sequence.unwrap().0,"expectedRevision":s.revision,"label":"Replace opening take",
        "steps":[{"command":"clip.replaceFromBin","params":{"clips":[clip],"item":replacement.0}}]})
    };
    let p = request(&s);
    let token = run(&mut s, p);
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    for c in [clip, audio] {
        assert_eq!(s.active_sequence().unwrap().find_item(ClipId(c)).unwrap().1.item, replacement);
    }
    s.execute("edit.undo", json!({})).unwrap();
    let frame = s.sequence_rate().frame_duration();
    s.edit("Short source fixture", |p, _| {
        p.item_mut(replacement).unwrap().as_media_mut().unwrap().info.duration = frame;
        Ok(())
    })
    .unwrap();
    let base = s.project.clone();
    let p = request(&s);
    assert!(s.execute("proposal.preview", p).is_err());
    assert!(Arc::ptr_eq(&s.project, &base));
}

#[test]
fn exact_clamping_locked_partner_and_render_limits_are_rejected() {
    let (mut s, clip, source, audio) = fixture();
    let mut p = trim(&s, clip, source);
    p["steps"][0]["params"]["deltaFrames"] = json!(100_000);
    assert!(s.execute("proposal.preview", p).is_err());
    let p = trim(&s, clip, source);
    let token = run(&mut s, p);
    for params in [
        json!({"token":token,"frame":-1}),
        json!({"token":token,"frame":i64::MAX}),
        json!({"token":token,"frame":0,"maxSide":257}),
        json!({"token":token,"frame":0,"maxSide":0}),
        json!({"token":token,"frame":0,"unknown":true}),
    ] {
        assert!(s.execute("proposal.render", params).is_err());
    }
    s.execute("proposal.cancel", json!({"token":token})).unwrap();
    let track = s.active_sequence().unwrap().find_item(ClipId(audio)).unwrap().0;
    s.execute("timeline.setTrack", json!({"track":track.0,"locked":true})).unwrap();
    let p = trim(&s, clip, source);
    assert!(s.execute("proposal.preview", p).is_err());
}

struct UnreadySource {
    info: filmcraft_media::MediaInfo,
    pending: bool,
}

impl filmcraft_media::MediaSource for UnreadySource {
    fn info(&self) -> &filmcraft_media::MediaInfo {
        &self.info
    }
    fn video_frame(&self, _: filmcraft_media::FrameRequest) -> filmcraft_media::Result<Arc<filmcraft_frame::VideoFrame>> {
        if self.pending {
            filmcraft_media::pending::mark();
        }
        Err(filmcraft_media::MediaError::Decode("synthetic decode failure".into()))
    }
    fn audio(&self, _: i64, _: usize, _: u32) -> filmcraft_media::Result<filmcraft_frame::AudioBuffer> {
        Err(filmcraft_media::MediaError::NoStream("audio"))
    }
}

#[test]
fn unready_or_failed_source_is_not_a_successful_render() {
    let (mut s, clip, source, _) = fixture();
    let info = s.source(ItemId(source)).unwrap().info().clone();
    s.media.insert(ItemId(source), Arc::new(UnreadySource { info: info.clone(), pending: true }));
    let p = trim(&s, clip, source);
    let token = run(&mut s, p);
    let render = s.execute("proposal.render", json!({"token":token,"frame":0,"maxSide":32})).unwrap();
    assert_eq!(render, json!({"pending":true}));
    s.media.insert(ItemId(source), Arc::new(UnreadySource { info, pending: false }));
    let error = s.execute("proposal.render", json!({"token":token,"frame":0,"maxSide":32})).unwrap_err();
    assert!(error.to_string().contains("decode failed"));
}

#[test]
fn missing_source_does_not_render_an_offline_slate_as_candidate() {
    let (mut s, clip, source, _) = fixture();
    s.edit("Missing source fixture", |p, _| {
        p.item_mut(ItemId(source)).unwrap().as_media_mut().unwrap().media =
            filmcraft_project::MediaRef::File { path: "/private/tmp/shway-deliberately-missing-proposal-media.mp4".into() };
        Ok(())
    })
    .unwrap();
    s.media.remove(ItemId(source));
    let p = trim(&s, clip, source);
    let token = run(&mut s, p);
    assert!(s.execute("proposal.render", json!({"token":token,"frame":0,"maxSide":32})).unwrap_err().to_string().contains("unavailable"));
}

#[test]
fn multiple_successful_steps_commit_and_undo_together() {
    let (mut s, clip, source, _) = fixture();
    let base = s.project.clone();
    let undo = s.history.undo.len();
    let mut p = trim(&s, clip, source);
    let second = p["steps"][0].clone();
    p["steps"].as_array_mut().unwrap().push(second);
    let token = run(&mut s, p);
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    assert_eq!(s.history.undo.len(), undo + 1);
    let before_duration = base.sequence(s.state.active_sequence.unwrap()).unwrap().find_item(ClipId(clip)).unwrap().1.duration;
    let duration = s.active_sequence().unwrap().find_item(ClipId(clip)).unwrap().1.duration;
    assert_eq!(duration, before_duration - s.sequence_rate().tick_of(2));
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(*s.project, *base);
}

#[test]
fn failed_commit_does_not_settle_a_new_dynamic_trim() {
    let (mut s, clip, source, _) = fixture();
    let p = trim(&s, clip, source);
    let token = run(&mut s, p);
    s.execute("trim.selectEditPoint", json!({"clip":clip,"edge":"out","kind":"trim"})).unwrap();
    s.execute("trim.shuttle", json!({"direction":"reverse","clock":0.0})).unwrap();
    s.execute("trim.tick", json!({"clock":0.1})).unwrap();
    let project = s.project.clone();
    let history = s.history.undo.clone();
    let revision = s.revision;
    assert!(s.execute("proposal.commit", json!({"token":token})).is_err());
    assert!(Arc::ptr_eq(&s.project, &project));
    assert_eq!(s.history.undo, history);
    assert_eq!(s.revision, revision);
    assert!(s.trim_play.active());
    s.execute("proposal.cancel", json!({"token":token})).unwrap();
    assert!(s.trim_play.active());
}

#[test]
fn cumulative_target_references_are_bounded_before_parsing() {
    let (mut s, clip, source, _) = fixture();
    let mut p = trim(&s, clip, source);
    let replacement = json!({"command":"clip.replaceFromBin","params":{"clips":vec![clip;17],"item":source}});
    p["steps"] = json!([replacement.clone(), replacement]);
    let error = s.execute("proposal.preview", p).unwrap_err();
    assert!(error.to_string().contains("32 explicit target references"));
    assert!(s.proposal.is_none());
}

#[test]
fn a_first_cut_of_more_than_32_ranges_is_one_preview_and_one_undo_step() {
    let (mut s, a, _, f) = assembly_fixture();
    // project.inspect tells an agent which bin items have audio and their picture format.
    let mut stack = vec![s.execute("project.inspect", json!({})).unwrap()["root"].clone()];
    let entry = loop {
        let node = stack.pop().unwrap();
        if node["item"] == json!(a) {
            break node;
        }
        stack.extend(node["children"].as_array().cloned().unwrap_or_default());
    };
    assert_eq!((entry["hasAudio"].clone(), entry["frameRate"]["num"].is_i64()), (json!(true), true));
    assert!(entry["width"].as_u64().unwrap() > 0 && entry["height"].as_u64().unwrap() > 0);
    let undo = s.history.undo.len();
    let ranges: Vec<Value> = (0..100).map(|i| json!({"item":a,"sourceIn":(i % 20) * f,"sourceOut":(i % 20 + 1) * f})).collect();
    let p = assemble(&s, json!(ranges));
    let token = run(&mut s, p);
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    assert_eq!(s.history.undo.len(), undo + 1);
    assert_eq!(s.active_sequence().unwrap().duration().0, 100 * f);
    // 513 ranges are refused before parsing, split over steps or not; other targets keep their 32.
    let range = json!({"item":a,"sourceIn":0,"sourceOut":f});
    let mut split = assemble(&s, json!(vec![range.clone(); 500]));
    split["steps"] = json!([split["steps"][0].clone(), {"command":"timeline.place","params":{"ranges":vec![range.clone(); 13]}}]);
    for p in [assemble(&s, json!(vec![range; 513])), split] {
        let error = s.execute("proposal.preview", p).unwrap_err();
        assert!(error.to_string().contains("512 source ranges"), "{error}");
        assert!(s.proposal.is_none());
    }
}

#[test]
fn hostile_source_marks_are_rejected_before_inherited_range_arithmetic() {
    let (mut s, clip, source, _) = fixture();
    s.edit("Corrupt source marks fixture", |p, _| {
        p.item_mut(ItemId(source)).unwrap().as_media_mut().unwrap().mark_out = Some(filmcraft_time::Tick(i64::MAX));
        Ok(())
    })
    .unwrap();
    let base = s.project.clone();
    let p = trim(&s, clip, source);
    assert!(s.execute("proposal.preview", p).is_err());
    assert!(Arc::ptr_eq(&s.project, &base));
    assert!(s.proposal.is_none());
}

#[test]
fn permanent_decode_failure_wins_over_pending_peer_in_both_layer_orders() {
    for pending_on_top in [false, true] {
        let (mut s, _, source, _) = fixture();
        let other = s.project.items.values().find(|i| i.id != ItemId(source) && i.as_media().is_some() && i.has_video()).unwrap().id;
        s.execute("file.newSequence", json!({"name":"Mixed source state","video":2,"audio":0,"width":64,"height":36})).unwrap();
        for (item, track) in [(ItemId(source), "V1"), (other, "V2")] {
            s.execute("timeline.place", json!({"item":item.0,"track":track,"audio":false,"frame":0,"duration":s.sequence_rate().tick_of(4).0})).unwrap();
            let info = s.source(item).unwrap().info().clone();
            let pending = (track == "V2") == pending_on_top;
            s.media.insert(item, Arc::new(UnreadySource { info, pending }));
        }
        let clip = s.active_sequence().unwrap().video_tracks[0].items[0].id.0;
        let p = trim(&s, clip, source);
        let token = run(&mut s, p);
        let error = s.execute("proposal.render", json!({"token":token,"frame":0,"maxSide":32})).unwrap_err();
        assert!(error.to_string().contains("decode failed"), "pending top={pending_on_top}: {error}");
    }
}

#[test]
fn unresolved_source_wins_over_pending_peer_in_both_layer_orders() {
    for pending_on_top in [false, true] {
        let (mut s, _, source, _) = fixture();
        s.execute("file.newSequence", json!({"name":"Missing layer","video":2,"audio":0,"width":64,"height":36})).unwrap();
        for track in ["V1", "V2"] {
            s.execute("timeline.place", json!({"item":source,"track":track,"audio":false,"frame":0,"duration":s.sequence_rate().tick_of(4).0})).unwrap();
        }
        let seq = s.state.active_sequence.unwrap();
        let missing_track = usize::from(!pending_on_top);
        s.edit("Dangling media fixture", |p, _| {
            p.sequence_mut(seq).unwrap().video_tracks[missing_track].items[0].item = ItemId(999_999);
            Ok(())
        })
        .unwrap();
        let clip = s.active_sequence().unwrap().video_tracks[usize::from(pending_on_top)].items[0].id.0;
        let info = s.source(ItemId(source)).unwrap().info().clone();
        s.media.insert(ItemId(source), Arc::new(UnreadySource { info, pending: true }));
        let p = trim(&s, clip, source);
        let token = run(&mut s, p);
        let error = s.execute("proposal.render", json!({"token":token,"frame":0,"maxSide":32})).unwrap_err();
        assert!(error.to_string().contains("cannot be opened"), "pending top={pending_on_top}: {error}");
    }
}

/// An empty new sequence plus two finite A/V sources and the sequence frame duration in ticks.
fn assembly_fixture() -> (Session, u64, u64, i64) {
    let (mut s, _, a, _) = fixture();
    let b = s.project.items.values().find(|i| i.id != ItemId(a) && i.as_media().is_some() && i.has_audio() && i.has_video()).unwrap().id.0;
    s.execute("file.newSequence", json!({"name":"First cut","width":64,"height":36})).unwrap();
    let f = s.sequence_rate().frame_duration().0;
    (s, a, b, f)
}

fn assemble(s: &Session, ranges: Value) -> Value {
    json!({"expectedRevision":s.revision,"sequence":s.state.active_sequence.unwrap().0,"label":"Assemble first cut",
        "steps":[{"command":"timeline.place","params":{"ranges":ranges}}]})
}

#[test]
fn assembly_places_exact_ranges_in_order_with_synced_audio_as_one_undo_step() {
    let (mut s, a, b, f) = assembly_fixture();
    let base = s.project.clone();
    let undo = s.history.undo.len();
    let ranges = json!([
        {"item":a,"sourceIn":2*f,"sourceOut":10*f},
        {"item":b,"sourceIn":0,"sourceOut":5*f},
        {"item":a,"sourceIn":20*f,"sourceOut":23*f},
    ]);
    let p = assemble(&s, ranges);
    let token = run(&mut s, p);
    assert!(Arc::ptr_eq(&s.project, &base));
    let preview = s.execute("proposal.inspect", json!({"token":token})).unwrap();
    let expected = [(a, 0, 8 * f, 2 * f), (b, 8 * f, 5 * f, 0), (a, 13 * f, 3 * f, 20 * f)];
    for kind in ["video", "audio"] {
        let items = preview["sequence"][kind][0]["items"].as_array().unwrap();
        assert_eq!(items.len(), 3, "{kind}");
        for (clip, (item, start, duration, source_in)) in items.iter().zip(expected) {
            assert_eq!((clip["item"].as_u64().unwrap(), clip["start"].as_i64().unwrap()), (item, start));
            assert_eq!((clip["duration"].as_i64().unwrap(), clip["sourceIn"].as_i64().unwrap()), (duration, source_in));
        }
    }
    let video = &preview["sequence"]["video"][0]["items"];
    let audio = &preview["sequence"]["audio"][0]["items"];
    for i in 0..3 {
        assert!(!video[i]["link"].is_null());
        assert_eq!(video[i]["link"], audio[i]["link"]);
    }
    assert_eq!(preview["results"][0]["placed"].as_array().unwrap().len(), 3);
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    assert_eq!(s.history.undo.len(), undo + 1);
    assert_eq!(s.active_sequence().unwrap().duration().0, 16 * f);
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(*s.project, *base);
}

#[test]
fn assembly_appends_after_existing_content_without_touching_it() {
    let (mut s, _, source, _) = fixture();
    let before = s.active_sequence().unwrap().clone();
    let end = before.duration().0;
    let f = s.sequence_rate().frame_duration().0;
    let p = assemble(&s, json!([{"item":source,"sourceIn":0,"sourceOut":4*f}]));
    let token = run(&mut s, p);
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    let q = s.active_sequence().unwrap();
    for (old, new) in before.video_tracks.iter().zip(&q.video_tracks).chain(before.audio_tracks.iter().zip(&q.audio_tracks)) {
        assert_eq!(new.items.iter().filter(|c| c.start.0 < end).cloned().collect::<Vec<_>>(), old.items);
    }
    assert_eq!(q.video_tracks[0].items.last().unwrap().start.0, end);
}

#[test]
fn assembly_cancel_leaves_project_untouched() {
    let (mut s, a, _, f) = assembly_fixture();
    let base = s.project.clone();
    let (undo, revision) = (s.history.undo.clone(), s.revision);
    let p = assemble(&s, json!([{"item":a,"sourceIn":0,"sourceOut":f}]));
    let token = run(&mut s, p);
    s.execute("proposal.cancel", json!({"token":token})).unwrap();
    assert!(Arc::ptr_eq(&s.project, &base));
    assert_eq!((s.history.undo.clone(), s.revision), (undo, revision));
    assert!(s.proposal.is_none());
}

#[test]
fn hostile_assembly_ranges_are_rejected_without_a_candidate() {
    let (mut s, a, _, f) = assembly_fixture();
    let end = s.project.item(ItemId(a)).unwrap().as_media().unwrap().info.duration.0;
    let seq = s.state.active_sequence.unwrap().0;
    let range = |item: u64, i: i64, o: i64| json!({"item":item,"sourceIn":i,"sourceOut":o});
    let mut cases = vec![
        ("overflow", assemble(&s, json!([range(a, 0, i64::MAX)]))),
        ("float", assemble(&s, json!([{"item":a,"sourceIn":0,"sourceOut":1e300}]))),
        ("negative", assemble(&s, json!([range(a, -f, f)]))),
        ("zero length", assemble(&s, json!([range(a, f, f)]))),
        ("reversed", assemble(&s, json!([range(a, 2 * f, f)]))),
        ("past end", assemble(&s, json!([range(a, 0, end + f)]))),
        ("unaligned", assemble(&s, json!([range(a, 1, f)]))),
        ("missing item", assemble(&s, json!([range(999_999, 0, f)]))),
        ("zero item", assemble(&s, json!([range(0, 0, f)]))),
        ("sequence item", assemble(&s, json!([range(seq, 0, f)]))),
        ("unknown field", assemble(&s, json!([{"item":a,"sourceIn":0,"sourceOut":f,"speed":2}]))),
        ("empty", assemble(&s, json!([]))),
        ("too many", assemble(&s, json!(vec![range(a, 0, f); 513]))),
    ];
    let mut stale = assemble(&s, json!([range(a, 0, f)]));
    stale["expectedRevision"] = json!(s.revision - 1);
    cases.push(("stale", stale));
    let base = s.project.clone();
    let history = s.history.undo.clone();
    for (name, p) in cases {
        let error = s.execute("proposal.preview", p).unwrap_err().to_string();
        // Each case must hit its own guard, not an incidental later failure.
        let expected = match name {
            "overflow" => "exact supported ticks",
            "float" | "unknown field" => "invalid parameters",
            "negative" | "zero length" | "reversed" | "past end" => "0 <= sourceIn < sourceOut <= source duration",
            "unaligned" => "frame boundaries",
            "missing item" => "missing source item",
            "zero item" => "positive exact browser integers",
            "sequence item" => "only finite media",
            "empty" => "at least one source range",
            "too many" => "512 source ranges",
            _ => "stale revision",
        };
        assert!(error.contains(expected), "{name}: {error}");
        assert!(Arc::ptr_eq(&s.project, &base), "{name}");
        assert_eq!(s.history.undo, history, "{name}");
        assert!(s.proposal.is_none(), "{name}");
    }
}

#[test]
fn assembly_rejects_offline_sources_and_locked_targets() {
    let (mut s, a, _, f) = assembly_fixture();
    s.edit("Offline source fixture", |p, _| {
        p.item_mut(ItemId(a)).unwrap().as_media_mut().unwrap().offline = true;
        Ok(())
    })
    .unwrap();
    let p = assemble(&s, json!([{"item":a,"sourceIn":0,"sourceOut":f}]));
    assert!(s.execute("proposal.preview", p).unwrap_err().to_string().contains("offline"));
    for kind in ["video", "audio"] {
        let (mut s, a, _, f) = assembly_fixture();
        let q = s.active_sequence().unwrap();
        let track = if kind == "video" { q.video_tracks[0].id } else { q.audio_tracks[0].id };
        s.execute("timeline.setTrack", json!({"track":track.0,"locked":true})).unwrap();
        let base = s.project.clone();
        let p = assemble(&s, json!([{"item":a,"sourceIn":0,"sourceOut":f}]));
        assert!(s.execute("proposal.preview", p).unwrap_err().to_string().contains("locked"), "{kind}");
        assert!(Arc::ptr_eq(&s.project, &base));
        assert!(s.proposal.is_none());
    }
}

/// Four committed, contiguous linked A/V clips of 8, 5, 3 and 6 frames: [(picture, sound); 4].
fn cut_fixture() -> (Session, [(u64, u64); 4], i64) {
    let (mut s, a, b, f) = assembly_fixture();
    let ranges = json!([
        {"item":a,"sourceIn":0,"sourceOut":8*f},
        {"item":b,"sourceIn":0,"sourceOut":5*f},
        {"item":a,"sourceIn":20*f,"sourceOut":23*f},
        {"item":b,"sourceIn":10*f,"sourceOut":16*f},
    ]);
    let p = assemble(&s, ranges);
    let token = run(&mut s, p);
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    let q = s.active_sequence().unwrap();
    let pairs = [0, 1, 2, 3].map(|n| (q.video_tracks[0].items[n].id.0, q.audio_tracks[0].items[n].id.0));
    (s, pairs, f)
}

fn edit(s: &Session, steps: Value) -> Value {
    json!({"expectedRevision":s.revision,"sequence":s.state.active_sequence.unwrap().0,"label":"Tighten cut","steps":steps})
}

fn remove(clips: &[u64]) -> Value {
    json!({"command":"timeline.remove","params":{"clips":clips}})
}

fn rearrange(clip: u64, anchor: u64, position: &str) -> Value {
    json!({"command":"timeline.move","params":{"clip":clip,"anchor":anchor,"position":position}})
}

/// (id, start) on V1 and A1 in time order, and whether each picture shares link and range with
/// the sound at the same index.
fn layout(s: &Session) -> (Vec<(u64, i64)>, Vec<(u64, i64)>, bool) {
    let q = s.active_sequence().unwrap();
    q.check().unwrap();
    let row = |t: &filmcraft_project::Track| t.items.iter().map(|i| (i.id.0, i.start.0)).collect::<Vec<_>>();
    let (v, a) = (&q.video_tracks[0].items, &q.audio_tracks[0].items);
    let synced = v.len() == a.len() && v.iter().zip(a).all(|(v, a)| v.link.is_some() && v.link == a.link && v.range() == a.range());
    (row(&q.video_tracks[0]), row(&q.audio_tracks[0]), synced)
}

fn ids(row: &[(u64, i64)]) -> Vec<u64> {
    row.iter().map(|c| c.0).collect()
}

#[test]
fn remove_ripples_linked_pairs_and_commits_as_one_undo_step() {
    for (victims, kept, closed) in [(vec![1usize], vec![0usize, 2, 3], 5), (vec![0, 2], vec![1, 3], 11)] {
        let (mut s, pairs, f) = cut_fixture();
        let base = s.project.clone();
        let undo = s.history.undo.len();
        let length = s.active_sequence().unwrap().duration().0;
        // Naming only the picture removes its sound too.
        let named: Vec<u64> = victims.iter().map(|n| pairs[*n].0).collect();
        let p = edit(&s, json!([remove(&named)]));
        let token = run(&mut s, p);
        assert!(Arc::ptr_eq(&s.project, &base), "staged only");
        let preview = s.execute("proposal.inspect", json!({"token":token})).unwrap();
        assert_eq!(preview["results"][0]["closed"], closed * f);
        assert_eq!(preview["results"][0]["removed"].as_array().unwrap().len(), 2 * victims.len());
        s.execute("proposal.commit", json!({"token":token})).unwrap();
        assert_eq!(s.history.undo.len(), undo + 1);
        let (v, a, synced) = layout(&s);
        assert!(synced);
        assert_eq!(ids(&v), kept.iter().map(|n| pairs[*n].0).collect::<Vec<_>>());
        assert_eq!(ids(&a), kept.iter().map(|n| pairs[*n].1).collect::<Vec<_>>());
        let q = s.active_sequence().unwrap();
        assert_eq!(q.video_tracks[0].items[0].start.0, 0);
        assert!(q.video_tracks[0].items.windows(2).all(|w| w[0].end() == w[1].start), "gap closed");
        assert_eq!(q.duration().0, length - closed * f);
        s.execute("edit.undo", json!({})).unwrap();
        assert_eq!(*s.project, *base);
    }
}

#[test]
fn remove_and_move_cancel_leaves_timeline_untouched() {
    let (mut s, pairs, _) = cut_fixture();
    let base = s.project.clone();
    let (undo, revision) = (s.history.undo.clone(), s.revision);
    let p = edit(&s, json!([remove(&[pairs[0].0]), rearrange(pairs[3].0, pairs[1].0, "before")]));
    let token = run(&mut s, p);
    s.execute("proposal.cancel", json!({"token":token})).unwrap();
    assert!(Arc::ptr_eq(&s.project, &base));
    assert_eq!((s.history.undo.clone(), s.revision), (undo, revision));
    assert!(s.proposal.is_none());
}

#[test]
fn move_reorders_linked_pairs_both_directions_without_gaps() {
    // (clip, anchor, position) -> resulting order of the four pairs.
    for (clip, anchor, position, order) in
        [(0, 2, "after", [1, 2, 0, 3]), (3, 0, "before", [3, 0, 1, 2]), (1, 3, "after", [0, 2, 3, 1]), (2, 1, "before", [0, 2, 1, 3])]
    {
        let (mut s, pairs, _) = cut_fixture();
        let base = s.project.clone();
        let undo = s.history.undo.len();
        let length = s.active_sequence().unwrap().duration();
        let p = edit(&s, json!([rearrange(pairs[clip].0, pairs[anchor].0, position)]));
        let token = run(&mut s, p);
        assert!(Arc::ptr_eq(&s.project, &base));
        s.execute("proposal.commit", json!({"token":token})).unwrap();
        assert_eq!(s.history.undo.len(), undo + 1);
        let (v, a, synced) = layout(&s);
        assert!(synced, "{clip} {position} {anchor}");
        assert_eq!(ids(&v), order.map(|n| pairs[n].0).to_vec(), "{clip} {position} {anchor}");
        assert_eq!(ids(&a), order.map(|n| pairs[n].1).to_vec());
        let q = s.active_sequence().unwrap();
        assert_eq!(q.video_tracks[0].items[0].start.0, 0);
        assert!(q.video_tracks[0].items.windows(2).all(|w| w[0].end() == w[1].start));
        assert_eq!(q.duration(), length);
        s.execute("edit.undo", json!({})).unwrap();
        assert_eq!(*s.project, *base);
    }
}

#[test]
fn move_then_trim_and_remove_combine_into_one_undo_step() {
    let (mut s, pairs, f) = cut_fixture();
    let base = s.project.clone();
    let undo = s.history.undo.len();
    let source = s.active_sequence().unwrap().find_item(ClipId(pairs[3].0)).unwrap().1.item.0;
    let trim = json!({"command":"timeline.trim","params":{"clip":pairs[3].0,"source":source,"edge":"out","mode":"ripple","deltaFrames":-2}});
    // Remove names the sound only; its picture goes with it.
    let p = edit(&s, json!([rearrange(pairs[3].0, pairs[0].0, "before"), trim, remove(&[pairs[2].1])]));
    let token = run(&mut s, p);
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    assert_eq!(s.history.undo.len(), undo + 1);
    let (v, _, synced) = layout(&s);
    assert!(synced);
    assert_eq!(v, vec![(pairs[3].0, 0), (pairs[0].0, 4 * f), (pairs[1].0, 12 * f)]);
    assert_eq!(s.active_sequence().unwrap().duration().0, 17 * f);
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(*s.project, *base);
}

#[test]
fn hostile_remove_and_move_steps_are_rejected_without_a_candidate() {
    let (mut s, pairs, f) = cut_fixture();
    let (p0, p1, p3) = (pairs[0].0, pairs[1].0, pairs[3].0);
    // A clip on a second sequence is outside the proposal's sequence.
    let seq = s.state.active_sequence.unwrap();
    let source = s.active_sequence().unwrap().video_tracks[0].items[0].item.0;
    s.execute("file.newSequence", json!({"name":"Other","width":64,"height":36})).unwrap();
    s.execute("timeline.place", json!({"item":source,"frame":0,"duration":4 * f})).unwrap();
    let foreign = s.active_sequence().unwrap().video_tracks[0].items[0].id.0;
    s.execute("sequence.open", json!({"item":seq.0})).unwrap();
    assert_eq!(s.state.active_sequence, Some(seq));
    let cases = [
        ("empty", json!([remove(&[])]), "need 1–32"),
        ("duplicate", json!([remove(&[p0, p0])]), "duplicate"),
        ("unknown", json!([remove(&[999_999])]), "missing clip"),
        ("foreign", json!([remove(&[foreign])]), "missing clip"),
        ("zero", json!([remove(&[0])]), "positive exact"),
        ("too many", json!([remove(&vec![p0; 33])]), "32 explicit target references"),
        ("unknown field", json!([{"command":"timeline.remove","params":{"clips":[p0],"gap":true}}]), "invalid parameters"),
        ("same", json!([rearrange(p0, p0, "after")]), "must differ"),
        ("partner anchor", json!([rearrange(p0, pairs[0].1, "after")]), "linked to the moved clip"),
        ("other track", json!([rearrange(p0, pairs[2].1, "after")]), "moved clip's track"),
        ("unknown clip", json!([rearrange(999_999, p0, "after")]), "missing clip"),
        ("unknown anchor", json!([rearrange(p0, 999_999, "after")]), "missing clip"),
        ("zero anchor", json!([rearrange(p0, 0, "after")]), "positive exact"),
        ("no-op", json!([rearrange(p0, p1, "before")]), "already plays there"),
        ("no-op after", json!([rearrange(p1, p0, "after")]), "already plays there"),
        ("position", json!([rearrange(p0, p3, "over")]), "invalid parameters"),
        ("second fails", json!([rearrange(p3, p0, "before"), remove(&[999_999])]), "missing clip"),
    ];
    let base = s.project.clone();
    let history = s.history.undo.clone();
    for (name, steps, expected) in cases {
        let error = s.execute("proposal.preview", edit(&s, steps)).unwrap_err().to_string();
        assert!(error.contains(expected), "{name}: {error}");
        assert!(Arc::ptr_eq(&s.project, &base), "{name}");
        assert_eq!(s.history.undo, history, "{name}");
        assert!(s.proposal.is_none(), "{name}");
    }
    let mut stale = edit(&s, json!([remove(&[p0])]));
    stale["expectedRevision"] = json!(s.revision - 1);
    assert!(s.execute("proposal.preview", stale).unwrap_err().to_string().contains("stale revision"));
}

#[test]
fn move_that_would_close_a_foreign_gap_or_split_sync_locked_music_is_rejected() {
    // A gap after the moved clip would close along with the hole it leaves.
    let (mut s, pairs, f) = cut_fixture();
    s.execute("timeline.move", json!({"moves":[{"clip":pairs[3].0,"track":"V1","time":30 * f}],"linked":true})).unwrap();
    let base = s.project.clone();
    let error = s.execute("proposal.preview", edit(&s, json!([rearrange(pairs[2].0, pairs[3].0, "after")]))).unwrap_err().to_string();
    assert!(error.contains("re-plan"), "{error}");
    assert!(Arc::ptr_eq(&s.project, &base));
    // Music under the cut on a sync-locked track cannot follow a rearrangement.
    let (mut s, pairs, f) = cut_fixture();
    let source = s.active_sequence().unwrap().audio_tracks[0].items[0].item.0;
    s.execute("sequence.addTracks", json!({"video":0,"audio":1})).unwrap();
    let music = s.active_sequence().unwrap().audio_tracks.last().unwrap().id.0;
    s.execute("timeline.place", json!({"item":source,"track":music,"time":0,"video":false,"audio":true,"duration":22 * f})).unwrap();
    assert_eq!(s.active_sequence().unwrap().audio_tracks.last().unwrap().items.len(), 1);
    let base = s.project.clone();
    assert!(s.execute("proposal.preview", edit(&s, json!([rearrange(pairs[0].0, pairs[2].0, "after")]))).is_err());
    assert!(Arc::ptr_eq(&s.project, &base));
    assert!(s.proposal.is_none());
}

fn join(clip: u64, effect: &str, edge: &str) -> Value {
    json!({"command":"sequence.applyVideoTransition","params":{"clip":clip,"effect":effect,"edge":edge}})
}

#[test]
fn sketch_transition_follows_a_move_and_commits_as_one_undo_step() {
    let (mut s, pairs, _) = cut_fixture();
    let base = s.project.clone();
    let undo = s.history.undo.len();
    // "Use this video afterwards": the last shot moves after the first, then splits in from it.
    let p = edit(&s, json!([rearrange(pairs[3].0, pairs[0].0, "after"), join(pairs[3].0, "split", "in")]));
    let token = run(&mut s, p);
    assert!(Arc::ptr_eq(&s.project, &base), "staged only");
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    assert_eq!(s.history.undo.len(), undo + 1);
    let (v, _, synced) = layout(&s);
    assert!(synced);
    assert_eq!(ids(&v), [0, 3, 1, 2].map(|n| pairs[n].0).to_vec(), "the moved clip keeps its id");
    let t = &s.active_sequence().unwrap().video_tracks[0].transitions;
    assert_eq!(t.len(), 1);
    assert_eq!((t[0].effect.effect.as_str(), t[0].from, t[0].to), ("split", Some(ClipId(pairs[0].0)), Some(ClipId(pairs[3].0))));
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(*s.project, *base);

    // Push takes the arrow's direction.
    let mut push = join(pairs[1].0, "push", "out");
    push["params"]["direction"] = json!("left");
    let p = edit(&s, json!([push]));
    let token = run(&mut s, p);
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    let t = &s.active_sequence().unwrap().video_tracks[0].transitions[0];
    assert_eq!(t.effect.param("direction").map(|p| &p.value), Some(&filmcraft_project::ParamValue::Choice(1)), "From East");
}

#[test]
fn hostile_transition_steps_are_rejected_without_a_candidate() {
    let (mut s, pairs, _) = cut_fixture();
    let mut directed = join(pairs[1].0, "split", "out");
    directed["params"]["direction"] = json!("left");
    let cases = [
        ("not allowed", json!([join(pairs[1].0, "cross_dissolve", "out")]), "must be one of split, push, iris_round"),
        ("display name", json!([join(pairs[1].0, "Split", "out")]), "must be one of"),
        ("direction", json!([directed]), "only push"),
        ("no neighbour", json!([join(pairs[0].0, "split", "in")]), "no adjacent clip"),
        ("unknown clip", json!([join(999_999, "split", "in")]), "missing clip"),
        ("edge", json!([join(pairs[1].0, "split", "middle")]), "invalid parameters"),
        (
            "extra",
            json!([{"command":"sequence.applyVideoTransition","params":{"clip":pairs[1].0,"effect":"split","edge":"in","frames":9999}}]),
            "invalid parameters",
        ),
    ];
    let base = s.project.clone();
    let history = s.history.undo.clone();
    for (name, steps, expected) in cases {
        let error = s.execute("proposal.preview", edit(&s, steps)).unwrap_err().to_string();
        assert!(error.contains(expected), "{name}: {error}");
        assert!(Arc::ptr_eq(&s.project, &base), "{name}");
        assert_eq!(s.history.undo, history, "{name}");
        assert!(s.proposal.is_none(), "{name}");
    }
}

fn zoom_proposal(s: &Session, clip: u64) -> Value {
    json!({"expectedRevision":s.revision,"sequence":s.state.active_sequence.unwrap().0,"label":"Zoom circled subject",
        "steps":[{"command":"clip.zoomRegion","params":{"clip":clip,"region":[0.1,0.2,0.4,0.6],"factor":2.0}}]})
}

#[test]
fn zoom_region_composes_motion_renders_and_is_one_undo_step() {
    let (mut s, clip, _, audio) = fixture();
    s.execute("effects.setParam", json!({"clip":clip,"effect":"motion","param":"position","value":[800,400]})).unwrap();
    s.execute("effects.setParam", json!({"clip":clip,"effect":"motion","param":"scale","value":120})).unwrap();
    s.execute("effects.setParam", json!({"clip":clip,"effect":"motion","param":"rotation","value":30})).unwrap();
    s.execute("effects.setParam", json!({"clip":clip,"effect":"motion","param":"anchor","value":[600,300]})).unwrap();
    s.execute("effects.setParam", json!({"clip":clip,"effect":"motion","param":"uniform_scale","value":false})).unwrap();
    s.execute("effects.setParam", json!({"clip":clip,"effect":"motion","param":"scale_width","value":80})).unwrap();
    let base = s.project.clone();
    let undo = s.history.undo.len();
    let settings = &s.active_sequence().unwrap().settings;
    let size = (settings.width, settings.height);
    let old = s.active_sequence().unwrap().find_item(ClipId(clip)).unwrap().1;
    let time = s.sequence_rate().snap(old.start + filmcraft_time::Tick(old.duration.0 / 2));
    let frame = s.sequence_rate().frame_at(time);
    let original = s.try_render_program_at(32.0 / size.0.max(size.1) as f32, time).unwrap().to_rgba8();
    let matrix = filmcraft_render::motion_matrix(s.active_sequence().unwrap(), old, size, old.source_in);
    let marked_source = matrix.inverse().unwrap().apply(filmcraft_geom::Vec2::new(0.25 * f64::from(size.0), 0.4 * f64::from(size.1)));
    let params = zoom_proposal(&s, clip);
    let token = run(&mut s, params);
    assert!(Arc::ptr_eq(&s.project, &base));
    let before = s.execute("proposal.render", json!({"token":token,"frame":frame,"maxSide":32})).unwrap();
    let pixels: Vec<u8> = before["rgba"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect();
    assert_ne!(pixels, original, "zoom must change rendered pixels");
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    let q = s.active_sequence().unwrap();
    let motion = q.find_item(ClipId(clip)).unwrap().1.effect("motion").unwrap();
    assert_eq!(motion.f64_at("scale", time), 240.0);
    assert_eq!(motion.f64_at("scale_width", time), 160.0);
    assert_eq!(motion.f64_at("rotation", time), 30.0);
    let now = q.find_item(ClipId(clip)).unwrap().1;
    let marked_output = filmcraft_render::motion_matrix(q, now, size, now.source_in).apply(marked_source);
    assert!((marked_output.x - f64::from(size.0) / 2.0).abs() < 1e-6);
    assert!((marked_output.y - f64::from(size.1) / 2.0).abs() < 1e-6);
    let committed_pixels = s.try_render_program_at(32.0 / size.0.max(size.1) as f32, time).unwrap().to_rgba8();
    assert_eq!(pixels, committed_pixels, "candidate and accepted render must match");
    let pos = motion.vec2_at("position", time);
    let w = f64::from(q.settings.width);
    let h = f64::from(q.settings.height);
    assert!((pos.x - (w / 2.0 + 2.0 * (800.0 - 0.25 * w))).abs() < 1e-6);
    assert!((pos.y - (h / 2.0 + 2.0 * (400.0 - 0.4 * h))).abs() < 1e-6);
    assert_eq!(q.find_item(ClipId(audio)).unwrap().1, base.sequence(s.state.active_sequence.unwrap()).unwrap().find_item(ClipId(audio)).unwrap().1);
    assert_eq!(s.history.undo.len(), undo + 1);
    let saved = serde_json::to_string(&*s.project).unwrap();
    let reopened: filmcraft_project::Project = serde_json::from_str(&saved).unwrap();
    assert_eq!(reopened, *s.project);
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(*s.project, *base);
    let params = zoom_proposal(&s, clip);
    let token = run(&mut s, params);
    s.execute("proposal.cancel", json!({"token":token})).unwrap();
    assert_eq!(*s.project, *base);
}

#[test]
fn zoom_region_rejects_hostile_locked_audio_animated_and_stale_inputs() {
    let (mut s, clip, _, audio) = fixture();
    let base = s.project.clone();
    for params in [
        json!({"clip":clip,"region":[0,0,1,2],"factor":2}),
        json!({"clip":clip,"region":[0.8,0,0.2,1],"factor":2}),
        json!({"clip":clip,"region":[0,0,0.01,1],"factor":2}),
        json!({"clip":clip,"region":[0,0,1],"factor":2}),
        json!({"clip":clip,"region":[0,0,1,1],"factor":1}),
        json!({"clip":clip,"region":[0,0,1,1],"factor":5}),
        json!({"clip":audio,"region":[0,0,1,1],"factor":2}),
        json!({"clip":0,"region":[0,0,1,1],"factor":2}),
        json!({"clip":clip,"region":[0,0,1,1],"factor":2,"extra":true}),
    ] {
        let mut p = zoom_proposal(&s, clip);
        p["steps"][0]["params"] = params;
        assert!(s.execute("proposal.preview", p).is_err());
        assert_eq!(*s.project, *base);
    }
    Arc::make_mut(&mut s.project).sequence_mut(s.state.active_sequence.unwrap()).unwrap().video_tracks[0].locked = true;
    let p = zoom_proposal(&s, clip);
    assert!(s.execute("proposal.preview", p).unwrap_err().to_string().contains("locked"));
    Arc::make_mut(&mut s.project).sequence_mut(s.state.active_sequence.unwrap()).unwrap().video_tracks[0].locked = false;
    let p = zoom_proposal(&s, clip);
    let token = run(&mut s, p);
    s.execute("effects.setParam", json!({"clip":clip,"effect":"motion","param":"scale","value":110})).unwrap();
    let newer = s.project.clone();
    assert!(s.execute("proposal.commit", json!({"token":token})).is_err());
    s.execute("proposal.cancel", json!({"token":token})).unwrap();
    assert_eq!(*s.project, *newer);
    s.execute("effects.toggleAnimation", json!({"clip":clip,"effect":"motion","param":"position"})).unwrap();
    let p = zoom_proposal(&s, clip);
    assert!(s.execute("proposal.preview", p).is_err());
}

fn command_step(command: &str, clips: Vec<u64>, args: Value) -> Value {
    json!({"command":"editor.command","params":{"id":command,"clips":clips,"args":args}})
}

#[test]
fn ordinary_tool_registry_reports_actual_coverage_and_effect_definitions() {
    let (mut s, _, _, _) = fixture();
    let catalog = s.execute("proposal.tools", json!({})).unwrap();
    eprintln!(
        "assistant tool coverage: {} generic tools, {} / {} core clip/timeline/effects commands, {} applicable effects",
        catalog["supported"], catalog["coreSupported"], catalog["coreRegisteredEditingCommands"], catalog["applicableEffects"]
    );
    assert!(catalog["coreSupported"].as_u64().unwrap() * 2 > catalog["coreRegisteredEditingCommands"].as_u64().unwrap());
    assert_eq!(
        catalog["coreRegisteredCommands"].as_u64().unwrap(),
        catalog["coreRegisteredEditingCommands"].as_u64().unwrap() + catalog["coverageExcluded"].as_array().unwrap().len() as u64
    );
    assert!(catalog["applicableEffects"].as_u64().unwrap() > 100);
    for t in catalog["tools"].as_array().unwrap() {
        assert!(crate::commands::find(t["id"].as_str().unwrap()).is_some());
    }
}

#[test]
fn ordinary_effect_keyframe_gain_speed_graphics_caption_tools_preview_commit_and_undo() {
    let cases = [
        ("effects.apply", json!({"effect":"gaussian_blur"})),
        ("effects.setParam", json!({"effect":"motion","param":"scale","value":120})),
        ("effects.toggleAnimation", json!({"effect":"motion","param":"scale"})),
        ("effects.addKeyframe", json!({"effect":"motion","param":"scale","time":254016000000i64})),
        ("clip.audioGain", json!({"mode":"adjust","db":-3})),
        ("clip.speedDuration", json!({"speed":125,"reverse":true,"ripple":false})),
        ("clip.rename", json!({"name":"Opening shot"})),
        ("clip.enable", json!({})),
        ("clip.group", json!({})),
        ("clip.fitToFrame", json!({})),
        ("clip.fillFrame", json!({})),
        ("clip.timeInterpolation.frameBlending", json!({})),
        ("clip.setTimeInterpolation", json!({"mode":"frameSampling"})),
        ("clip.nudgeVolumeUp3", json!({})),
        ("clip.volumeDown", json!({})),
        ("timeline.nudgeRight", json!({})),
        ("timeline.slipRight5", json!({})),
        ("timeline.slideRight", json!({})),
        ("timeline.razor", json!({"time":254016000000i64})),
        ("timeline.slip", json!({"deltaFrames":1})),
        ("graphics.newText", json!({"text":"Our workshop","size":60})),
        ("graphics.newShape", json!({"shape":"ellipse","size":[100,100]})),
        ("captions.add", json!({"text":"Welcome to our workshop"})),
    ];
    for (cmd, args) in cases {
        let (mut s, c, _, _) = fixture();
        let base = s.project.clone();
        let undo = s.history.undo.len();
        let p = edit(&s, json!([command_step(cmd, vec![c], args)]));
        let token = s.execute("proposal.preview", p).unwrap_or_else(|e| panic!("{cmd}: {e}"))["token"].as_u64().unwrap();
        assert!(Arc::ptr_eq(&s.project, &base), "{cmd}");
        s.execute("proposal.commit", json!({"token":token})).unwrap();
        assert_eq!(s.history.undo.len(), undo + 1, "{cmd}");
        s.execute("edit.undo", json!({})).unwrap();
        assert_eq!(*s.project, *base, "{cmd}");
    }
}

#[test]
fn ordinary_tools_reject_external_side_effects_hostile_values_and_target_injection() {
    let (mut s, c, _, _) = fixture();
    let base = s.project.clone();
    for (cmd, args) in [
        ("file.exportMedia", json!({"path":"/tmp/no.mp4"})),
        ("prefs.set", json!({})),
        ("effects.apply", json!({"effect":"unknown"})),
        ("effects.apply", json!({"effect":"split"})),
        ("effects.setParam", json!({"effect":"motion","param":"scale","value":1e30})),
        ("effects.setParam", json!({"effect":"motion","param":"scale","value":"huge"})),
        ("effects.setParam", json!({"effect":"motion","param":"scale","value":120,"clip":999})),
        ("clip.speedDuration", json!({"speed":0})),
        ("clip.speedDuration", json!({"speed":100000})),
        ("timeline.slip", json!({"deltaFrames":i64::MAX})),
        ("timeline.slip", json!({"deltaFrames":0})),
        ("graphics.newText", json!({"text":"x","size":1e9})),
    ] {
        let p = edit(&s, json!([command_step(cmd, vec![c], args)]));
        assert!(s.execute("proposal.preview", p).is_err(), "{cmd}");
        assert_eq!(*s.project, *base);
    }
    let p = edit(
        &s,
        json!([
            command_step("effects.setParam", vec![c], json!({"effect":"motion","param":"scale","value":120})),
            command_step("effects.apply", vec![c], json!({"effect":"unknown"}))
        ]),
    );
    let undo = s.history.undo.len();
    assert!(s.execute("proposal.preview", p).is_err());
    assert_eq!(*s.project, *base);
    assert_eq!(s.history.undo.len(), undo);
    assert!(s.proposal.is_none());
    Arc::make_mut(&mut s.project).sequence_mut(s.state.active_sequence.unwrap()).unwrap().audio_tracks[0].locked = true;
    let locked = s.project.clone();
    let p = edit(&s, json!([command_step("clip.nudgeVolumeUp3", vec![c], json!({}))]));
    assert!(s.execute("proposal.preview", p).unwrap_err().to_string().contains("locked"));
    assert_eq!(*s.project, *locked);
    assert!(s.proposal.is_none());
}

#[test]
fn transition_renders_temporal_candidate_frames_without_changing_live_time_and_matches_commit() {
    let (mut s, pairs, _) = cut_fixture();
    let base = s.project.clone();
    let ph = s.playhead();
    let p = edit(&s, json!([join(pairs[1].0, "split", "out")]));
    let token = run(&mut s, p);
    let inspection = s.execute("proposal.inspect", json!({"token":token})).unwrap();
    let t = &inspection["sequence"]["video"][0]["transitions"][0];
    let start = t["start"].as_i64().unwrap();
    let duration = t["duration"].as_i64().unwrap();
    let ft = s.sequence_rate().frame_duration().0;
    let last = (inspection["sequence"]["duration"].as_i64().unwrap() - 1) / ft;
    let frames = [start - ft, start + duration / 4, start + duration / 2, start + duration * 3 / 4, start + duration + ft]
        .map(|t| s.sequence_rate().frame_at(filmcraft_time::Tick(t.max(0))).min(last));
    let pixels: Vec<_> = frames.iter().map(|f| s.execute("proposal.render", json!({"token":token,"frame":f,"maxSide":64})).unwrap()).collect();
    if let Some(dir) = std::env::var_os("SHWAY_PREVIEW_EVIDENCE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (n, p) in pixels.iter().enumerate() {
            let rgba: Vec<u8> = p["rgba"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect();
            image::save_buffer(
                dir.join(format!("transition-{n}.png")),
                &rgba,
                p["width"].as_u64().unwrap() as u32,
                p["height"].as_u64().unwrap() as u32,
                image::ColorType::Rgba8,
            )
            .unwrap();
        }
    }
    assert!(pixels.windows(2).any(|p| p[0]["rgba"] != p[1]["rgba"]));
    assert_eq!(s.playhead(), ph);
    assert!(Arc::ptr_eq(&s.project, &base));
    s.execute("proposal.commit", json!({"token":token})).unwrap();
    let q = s.active_sequence().unwrap();
    let scale = 64.0 / q.settings.width.max(q.settings.height) as f32;
    for (frame, p) in frames.iter().zip(pixels) {
        let image = s.try_render_program_at(scale, s.sequence_rate().tick_of(*frame)).unwrap();
        assert_eq!(json!(image.to_rgba8()), p["rgba"]);
    }
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(*s.project, *base);
}
