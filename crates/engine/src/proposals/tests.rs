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
        ("too many", assemble(&s, json!(vec![range(a, 0, f); 33]))),
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
            "too many" => "32 explicit target references",
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
