//! The Shway wordmark, set in the UI font. A modified distribution must not show the upstream
//! ArtCraft trademark (AGENTS.md §1.8), so Shway draws its own name as text: no image asset.

/// The product name shown in the header, the Home screen and About.
pub const NAME: &str = "Shway";

/// Draw the wordmark `height` points tall with its left edge at `left_center` (vertically centred).
/// Returns the drawn rect.
pub fn paint_wordmark(ui: &egui::Ui, left_center: egui::Pos2, height: f32, dark: bool) -> Option<egui::Rect> {
    let color = if dark { egui::Color32::WHITE } else { egui::Color32::from_gray(20) };
    let galley = ui.painter().layout_no_wrap(NAME.to_string(), egui::FontId::proportional(height * 1.25), color);
    let r = egui::Rect::from_min_size(egui::pos2(left_center.x, left_center.y - galley.size().y / 2.0), galley.size());
    ui.painter().galley(r.min, galley, color);
    Some(r)
}
