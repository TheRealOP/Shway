//! Shway webcam tile (DEV-91). `node shway/assistant.mjs --camera` sends a small mirrored JPEG with the
//! hand landmarks drawn, about 10 times a second, as `ui.set {camera: "<base64>"}` (`null` clears). It is
//! painted in a corner of the dock that doesn't touch the Program monitor, so `ui.screenshot
//! {panel:"program"}` (the image a vision model reads) never contains it. No frame for 2 s hides it.

use base64::Engine as _;
use std::io::Cursor;

/// Base64 length cap; the assistant drops bigger previews too.
pub const MAX_BASE64: usize = 200 * 1024;
const MAX_SIDE: u32 = 1024;
const STALE_S: f64 = 2.0;
const WIDTH: f32 = 200.0;

pub struct Tile {
    tex: egui::TextureHandle,
    at: f64,
}

/// A base64 JPEG from an untrusted client → pixels, or None for anything malformed or too big.
pub fn decode(b64: &str) -> Option<egui::ColorImage> {
    if b64.len() > MAX_BASE64 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Jpeg);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(16 << 20);
    reader.limits(limits);
    let rgba = reader.decode().ok()?.to_rgba8();
    let size = [usize::try_from(rgba.width()).ok()?, usize::try_from(rgba.height()).ok()?];
    (size[0] > 0 && size[1] > 0).then(|| egui::ColorImage::from_rgba_unmultiplied(size, rgba.as_raw()))
}

/// `ui.set {camera}`: a string replaces the frame, `null` clears it, anything bad is ignored.
pub fn set(tile: &mut Option<Tile>, ctx: &egui::Context, v: &serde_json::Value) {
    if v.is_null() {
        *tile = None;
    } else if let Some(img) = v.as_str().and_then(decode) {
        let tex = ctx.load_texture("shway-camera", img, egui::TextureOptions::LINEAR);
        *tile = Some(Tile { tex, at: ctx.input(|i| i.time) });
    }
}

/// Paints the tile in the first corner of `area` that doesn't overlap the Program panel.
pub fn show(tile: Option<&Tile>, ui: &egui::Ui, area: egui::Rect, program: Option<egui::Rect>) {
    let Some(tile) = tile else { return };
    if ui.input(|i| i.time) - tile.at > STALE_S {
        return;
    }
    ui.ctx().request_repaint_after(std::time::Duration::from_millis(500)); // so it hides when frames stop
    let [w, h] = tile.tex.size().map(|v| v as f32);
    let size = egui::vec2(WIDTH, WIDTH * h / w.max(1.0));
    let inner = area.shrink(8.0);
    let corners = [inner.left_bottom() - egui::vec2(0.0, size.y), inner.right_bottom() - size, inner.left_top(), inner.right_top() - egui::vec2(size.x, 0.0)];
    let Some(rect) = corners
        .into_iter()
        .map(|min| egui::Rect::from_min_size(min, size))
        .find(|r| area.contains_rect(*r) && program.is_none_or(|p| !p.intersects(r.expand(2.0))))
    else {
        return;
    };
    let p = ui.painter();
    p.rect_filled(rect.expand(2.0), 4.0, egui::Color32::BLACK);
    p.image(tile.tex.id(), rect, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(w: u32, h: u32) -> String {
        let mut out = Vec::new();
        image::RgbImage::new(w, h).write_to(&mut Cursor::new(&mut out), image::ImageFormat::Jpeg).ok();
        base64::engine::general_purpose::STANDARD.encode(out)
    }

    #[test]
    fn decodes_a_preview() {
        let img = decode(&jpeg(240, 180));
        assert_eq!(img.map(|i| i.size), Some([240, 180]));
    }

    #[test]
    fn hostile_input_is_ignored() {
        let good = jpeg(16, 16);
        let b64 = base64::engine::general_purpose::STANDARD;
        let header_only = b64.encode(b64.decode(&good).unwrap_or_default().get(..20).unwrap_or_default());
        // a JPEG header claiming 60000×60000 (SOF0 dimensions patched)
        let mut huge = b64.decode(jpeg(8, 8)).unwrap_or_default();
        if let Some(i) = huge.windows(2).position(|w| w == [0xFF, 0xC0])
            && let Some(dims) = huge.get_mut(i + 5..i + 9)
        {
            dims.copy_from_slice(&[0xEA, 0x60, 0xEA, 0x60]);
        }
        let png = {
            let mut out = Vec::new();
            image::RgbImage::new(4, 4).write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).ok();
            b64.encode(out)
        };
        for bad in ["", "not base64!", "AAAA", &header_only, &b64.encode(&huge), &png, &"A".repeat(MAX_BASE64 + 4), &jpeg(1100, 8)] {
            assert!(decode(bad).is_none(), "{:.40}", bad);
        }
    }

    #[test]
    fn set_ignores_bad_values_and_null_clears() {
        let ctx = egui::Context::default();
        let mut tile = None;
        set(&mut tile, &ctx, &serde_json::json!("garbage"));
        set(&mut tile, &ctx, &serde_json::json!(42));
        assert!(tile.is_none());
        set(&mut tile, &ctx, &serde_json::json!(jpeg(32, 24)));
        assert_eq!(tile.as_ref().map(|t| t.tex.size()), Some([32, 24]));
        set(&mut tile, &ctx, &serde_json::json!("garbage"));
        assert!(tile.is_some(), "a bad frame keeps the last good one");
        set(&mut tile, &ctx, &serde_json::Value::Null);
        assert!(tile.is_none());
    }
}
