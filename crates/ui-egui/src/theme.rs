//! Design tokens. Every widget reads colours/sizes from [`Tokens`] so themes apply everywhere.
//!
//! The default theme is Shway's own "dark minimal" look: near-black surfaces, calm neutral greys,
//! soft dividers, rounded corners and one mint accent used sparingly (selection, primary buttons,
//! playhead, focus), so the video is the brightest thing on screen. The FilmCraft themes (measured
//! from black-box screenshots, see `plan/premiere/02-ui-ux.md`) stay available as Classic, Medium
//! and Light. Fonts are Inter + JetBrains Mono (OFL).

use std::sync::Arc;

use egui::{Color32, FontData, FontDefinitions, FontFamily, FontId, Stroke, TextStyle, Visuals};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThemeKind {
    /// Shway dark minimal (default).
    #[default]
    Shway,
    /// FilmCraft's Premiere-style darkest ("Classic").
    Dark,
    /// Slightly lighter grey panels (Premiere's brightness slider mid position).
    Medium,
    Light,
}

impl ThemeKind {
    /// Settings ▸ Appearance ▸ Color Theme value (`shway`, `darkest`, `dark`, `light`).
    pub fn pref_name(self) -> &'static str {
        match self {
            ThemeKind::Shway => "shway",
            ThemeKind::Dark => "darkest",
            ThemeKind::Medium => "dark",
            ThemeKind::Light => "light",
        }
    }
    pub fn from_pref(s: &str) -> ThemeKind {
        match s {
            "darkest" => ThemeKind::Dark,
            "dark" => ThemeKind::Medium,
            "light" => ThemeKind::Light,
            _ => ThemeKind::Shway,
        }
    }
    pub fn from_name(s: &str) -> Option<ThemeKind> {
        match s.to_ascii_lowercase().as_str() {
            "shway" => Some(ThemeKind::Shway),
            "dark" | "darkest" | "classic" => Some(ThemeKind::Dark),
            "medium" | "grey" | "gray" => Some(ThemeKind::Medium),
            "light" => Some(ThemeKind::Light),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tokens {
    pub kind: ThemeKind,
    /// Space between panels / app background.
    pub app_bg: Color32,
    /// Header bar (top).
    pub header_bg: Color32,
    /// Panel body.
    pub panel_bg: Color32,
    /// Panel tab strip.
    pub tab_bg: Color32,
    pub tab_text: Color32,
    pub tab_text_active: Color32,
    /// Blue focus rectangle around the active panel.
    pub focus: Color32,
    /// Primary-button / progress fill (white text on it stays AA).
    pub accent: Color32,
    pub accent_hover: Color32,
    /// Quiet accent tint: text-selection and selected-item backgrounds.
    pub accent_muted: Color32,
    /// Text primary / secondary / disabled.
    pub text: Color32,
    pub text_dim: Color32,
    pub text_faint: Color32,
    pub icon: Color32,
    pub icon_active: Color32,
    pub hover: Color32,
    pub pressed: Color32,
    pub field_bg: Color32,
    pub field_border: Color32,
    /// Divider between panels and sections.
    pub separator: Color32,
    pub row_alt: Color32,
    /// Selected row / item (selection).
    pub row_selected: Color32,
    /// Scrubby (hot-text) numeric value colour.
    pub hot_text: Color32,
    // timeline
    pub tl_bg: Color32,
    pub tl_track_bg: Color32,
    pub tl_track_bg_alt: Color32,
    pub tl_header_bg: Color32,
    pub tl_ruler_bg: Color32,
    pub tl_ruler_tick: Color32,
    pub tl_ruler_text: Color32,
    pub playhead: Color32,
    pub in_out_shade: Color32,
    pub clip_selected_border: Color32,
    pub render_red: Color32,
    pub render_yellow: Color32,
    pub render_green: Color32,
    pub monitor_bg: Color32,
    pub timecode: Color32,
    pub danger: Color32,
    pub radius: f32,
    pub radius_sm: f32,
    pub gap: f32,
    pub tab_h: f32,
}

impl Tokens {
    pub fn for_kind(kind: ThemeKind) -> Self {
        // Measured from Premiere 26 "Darkest" (plan/premiere/02-ui-ux.md §1).
        let dark = Tokens {
            kind,
            app_bg: Color32::from_rgb(0, 0, 0),
            header_bg: Color32::from_rgb(0x1d, 0x1d, 0x1d),
            panel_bg: Color32::from_rgb(0x1d, 0x1d, 0x1d),
            tab_bg: Color32::from_rgb(0x1d, 0x1d, 0x1d),
            tab_text: Color32::from_rgb(0xb0, 0xb0, 0xb0),
            tab_text_active: Color32::from_rgb(0xd1, 0xd1, 0xd1),
            focus: Color32::from_rgb(0x57, 0x94, 0xec),
            accent: Color32::from_rgb(0x2f, 0x6b, 0xdf),
            accent_hover: Color32::from_rgb(0x3f, 0x7c, 0xe8),
            accent_muted: Color32::from_rgb(0x2f, 0x6b, 0xdf),
            text: Color32::from_rgb(0xd1, 0xd1, 0xd1),
            text_dim: Color32::from_rgb(0xb0, 0xb0, 0xb0),
            text_faint: Color32::from_rgb(0x6e, 0x6e, 0x6e),
            icon: Color32::from_rgb(0xb0, 0xb0, 0xb0),
            icon_active: Color32::from_rgb(0xd1, 0xd1, 0xd1),
            hover: Color32::from_rgb(0x2c, 0x2c, 0x2c),
            pressed: Color32::from_rgb(0x4b, 0x4b, 0x4b),
            field_bg: Color32::from_rgb(0x0e, 0x0e, 0x0e),
            field_border: Color32::from_rgb(0x30, 0x30, 0x30),
            separator: Color32::from_rgb(0x30, 0x30, 0x30),
            row_alt: Color32::from_rgb(0x21, 0x21, 0x21),
            row_selected: Color32::from_rgb(0x33, 0x33, 0x33),
            hot_text: Color32::from_rgb(0x40, 0x96, 0xf3),
            tl_bg: Color32::from_rgb(0x1d, 0x1d, 0x1d),
            tl_track_bg: Color32::from_rgb(0x1d, 0x1d, 0x1d),
            tl_track_bg_alt: Color32::from_rgb(0x1d, 0x1d, 0x1d),
            tl_header_bg: Color32::from_rgb(0x1d, 0x1d, 0x1d),
            tl_ruler_bg: Color32::from_rgb(0x1d, 0x1d, 0x1d),
            tl_ruler_tick: Color32::from_rgb(0x8d, 0x8d, 0x8d),
            tl_ruler_text: Color32::from_rgb(0xb0, 0xb0, 0xb0),
            playhead: Color32::from_rgb(0x58, 0x95, 0xec),
            in_out_shade: Color32::from_rgb(0x3f, 0x3f, 0x3f),
            clip_selected_border: Color32::from_rgb(0xeb, 0xeb, 0xeb),
            render_red: Color32::from_rgb(0xe3, 0x48, 0x50),
            render_yellow: Color32::from_rgb(0xf0, 0xf0, 0x4f),
            render_green: Color32::from_rgb(0x2d, 0x9d, 0x78),
            monitor_bg: Color32::from_rgb(0x1d, 0x1d, 0x1d),
            timecode: Color32::from_rgb(0x40, 0x96, 0xf3),
            danger: Color32::from_rgb(0xdc, 0x51, 0x3d),
            radius: 0.0,
            radius_sm: 4.0,
            gap: 4.0,
            tab_h: 32.0,
        };
        match kind {
            ThemeKind::Shway => Self::shway(),
            ThemeKind::Dark => dark,
            ThemeKind::Medium => Tokens {
                app_bg: Color32::from_rgb(20, 20, 20),
                header_bg: Color32::from_rgb(0x32, 0x32, 0x32),
                panel_bg: Color32::from_rgb(0x32, 0x32, 0x32),
                tab_bg: Color32::from_rgb(0x32, 0x32, 0x32),
                field_bg: Color32::from_rgb(0x22, 0x22, 0x22),
                tl_bg: Color32::from_rgb(0x32, 0x32, 0x32),
                tl_track_bg: Color32::from_rgb(0x32, 0x32, 0x32),
                tl_track_bg_alt: Color32::from_rgb(0x32, 0x32, 0x32),
                tl_header_bg: Color32::from_rgb(0x32, 0x32, 0x32),
                tl_ruler_bg: Color32::from_rgb(0x32, 0x32, 0x32),
                monitor_bg: Color32::from_rgb(0x32, 0x32, 0x32),
                row_alt: Color32::from_rgb(50, 50, 50),
                hover: Color32::from_rgb(64, 64, 64),
                ..dark
            },
            ThemeKind::Light => Tokens {
                app_bg: Color32::from_rgb(180, 180, 180),
                header_bg: Color32::from_rgb(214, 214, 214),
                panel_bg: Color32::from_rgb(232, 232, 232),
                tab_bg: Color32::from_rgb(232, 232, 232),
                tab_text: Color32::from_rgb(90, 90, 90),
                tab_text_active: Color32::from_rgb(20, 20, 20),
                text: Color32::from_rgb(34, 34, 34),
                text_dim: Color32::from_rgb(90, 90, 90),
                text_faint: Color32::from_rgb(140, 140, 140),
                icon: Color32::from_rgb(60, 60, 60),
                hover: Color32::from_rgb(210, 210, 210),
                pressed: Color32::from_rgb(196, 196, 196),
                field_bg: Color32::from_rgb(250, 250, 250),
                field_border: Color32::from_rgb(170, 170, 170),
                separator: Color32::from_rgb(200, 200, 200),
                row_alt: Color32::from_rgb(224, 224, 224),
                row_selected: Color32::from_rgb(170, 200, 240),
                tl_bg: Color32::from_rgb(210, 210, 210),
                tl_track_bg: Color32::from_rgb(222, 222, 222),
                tl_track_bg_alt: Color32::from_rgb(228, 228, 228),
                tl_header_bg: Color32::from_rgb(214, 214, 214),
                tl_ruler_bg: Color32::from_rgb(226, 226, 226),
                tl_ruler_text: Color32::from_rgb(80, 80, 80),
                ..dark
            },
        }
    }

    /// Shway "dark minimal". Surfaces step up from near-black (app 0B0B0C, panel 141416, field
    /// 1C1D20, hover 25262A); the accent is mint: as far from Premiere's blue (hue ~220°) as from
    /// the danger red, so primary and destructive actions never read alike, and a bright mint
    /// playhead stays visible over every clip label colour. Contrast is checked in the tests.
    fn shway() -> Self {
        const SURFACE_0: Color32 = Color32::from_rgb(0x0b, 0x0b, 0x0c);
        const SURFACE_1: Color32 = Color32::from_rgb(0x14, 0x14, 0x16);
        const SURFACE_2: Color32 = Color32::from_rgb(0x1c, 0x1d, 0x20);
        const SURFACE_3: Color32 = Color32::from_rgb(0x25, 0x26, 0x2a);
        const TEXT: Color32 = Color32::from_rgb(0xe8, 0xe8, 0xea);
        const TEXT_2: Color32 = Color32::from_rgb(0xa3, 0xa3, 0xaa);
        const DIVIDER: Color32 = Color32::from_rgb(0x22, 0x23, 0x26);
        const MINT: Color32 = Color32::from_rgb(0x4f, 0xe0, 0xb5);
        Tokens {
            kind: ThemeKind::Shway,
            app_bg: SURFACE_0,
            header_bg: SURFACE_0,
            panel_bg: SURFACE_1,
            tab_bg: SURFACE_1,
            tab_text: Color32::from_rgb(0x9a, 0x9a, 0xa1),
            tab_text_active: TEXT,
            focus: MINT,
            accent: Color32::from_rgb(0x0f, 0x7d, 0x66),
            accent_hover: Color32::from_rgb(0x11, 0x82, 0x70),
            accent_muted: Color32::from_rgb(0x15, 0x39, 0x2f),
            text: TEXT,
            text_dim: TEXT_2,
            text_faint: Color32::from_rgb(0x6e, 0x6e, 0x76),
            icon: Color32::from_rgb(0x9a, 0x9a, 0xa1),
            icon_active: TEXT,
            hover: SURFACE_3,
            pressed: Color32::from_rgb(0x2e, 0x30, 0x35),
            field_bg: SURFACE_2,
            field_border: Color32::from_rgb(0x2a, 0x2b, 0x30),
            separator: DIVIDER,
            row_alt: Color32::from_rgb(0x17, 0x17, 0x1a),
            row_selected: Color32::from_rgb(0x15, 0x39, 0x2f),
            hot_text: MINT,
            tl_bg: Color32::from_rgb(0x10, 0x10, 0x12),
            tl_track_bg: SURFACE_1,
            tl_track_bg_alt: Color32::from_rgb(0x17, 0x17, 0x1a),
            tl_header_bg: SURFACE_1,
            tl_ruler_bg: Color32::from_rgb(0x10, 0x10, 0x12),
            tl_ruler_tick: Color32::from_rgb(0x4a, 0x4b, 0x52),
            tl_ruler_text: TEXT_2,
            playhead: MINT,
            in_out_shade: Color32::from_rgb(0x1f, 0x2e, 0x29),
            clip_selected_border: MINT,
            render_red: Color32::from_rgb(0xe5, 0x53, 0x4b),
            render_yellow: Color32::from_rgb(0xe8, 0xc5, 0x4a),
            render_green: Color32::from_rgb(0x3f, 0xa8, 0x7c),
            monitor_bg: SURFACE_0,
            timecode: MINT,
            danger: Color32::from_rgb(0xf0, 0x60, 0x5a),
            radius: 8.0,
            radius_sm: 6.0,
            gap: 6.0,
            tab_h: 32.0,
        }
    }

    /// Settings ▸ Appearance on top of a theme: the highlight colour (selections, focus, primary
    /// buttons) and accessible colour contrast (brighter secondary text and borders).
    pub fn with_appearance(mut self, highlight: Option<[u8; 3]>, accessible_contrast: bool) -> Self {
        // Shway keeps its mint unless the user picked a highlight other than the stock blue
        let stock = filmcraft_engine::settings::parse_hex(filmcraft_engine::settings::DEFAULT_HIGHLIGHT);
        if let Some([r, g, b]) = highlight.filter(|h| self.kind != ThemeKind::Shway || Some(*h) != stock) {
            let c = Color32::from_rgb(r, g, b);
            let lift = |v: u8| v.saturating_add(16);
            self.accent = c;
            self.accent_hover = Color32::from_rgb(lift(r), lift(g), lift(b));
            self.accent_muted = if self.kind == ThemeKind::Shway { self.panel_bg.lerp_to_gamma(c, 0.3) } else { c };
        }
        if accessible_contrast {
            if self.kind == ThemeKind::Light {
                self.text_dim = Color32::from_rgb(40, 40, 40);
                self.text_faint = Color32::from_rgb(80, 80, 80);
                self.field_border = Color32::from_rgb(110, 110, 110);
            } else {
                self.text_dim = self.text;
                self.text_faint = Color32::from_rgb(0xa8, 0xa8, 0xa8);
                self.tab_text = self.tab_text_active;
                self.field_border = Color32::from_rgb(0x6a, 0x6a, 0x6a);
                self.separator = Color32::from_rgb(0x50, 0x50, 0x50);
            }
        }
        self
    }

    /// Mono font for timecode.
    pub fn mono(size: f32) -> FontId {
        FontId::new(size, FontFamily::Monospace)
    }
    pub fn ui(size: f32) -> FontId {
        FontId::new(size, FontFamily::Proportional)
    }
    pub fn semibold(size: f32) -> FontId {
        FontId::new(size, FontFamily::Name("semibold".into()))
    }
    /// The big blue timecode over the timeline and under the monitors: regular weight, as in
    /// Premiere (Premiere's reads 10 px tall and 76 px wide for 00:00:16:05 at 1x).
    pub fn timecode() -> FontId {
        FontId::new(16.0, FontFamily::Proportional)
    }
}

/// Menu text: Premiere's menus are the system's, larger and brighter than panel text, one item
/// every 24 px.
pub const MENU_TEXT_SIZE: f32 = 13.0;
pub const MENU_TEXT: Color32 = Color32::from_rgb(0xde, 0xde, 0xde);

/// Style of the menu bar's menus and their submenus (on top of egui's own menu style).
pub fn menu_style(s: &mut egui::Style) {
    egui::containers::menu::menu_style(s);
    s.text_styles.insert(TextStyle::Button, FontId::new(MENU_TEXT_SIZE, FontFamily::Proportional));
    s.text_styles.insert(TextStyle::Body, FontId::new(MENU_TEXT_SIZE, FontFamily::Proportional));
    s.spacing.item_spacing.y = 0.0;
    if s.visuals.dark_mode {
        s.visuals.override_text_color = Some(MENU_TEXT);
    }
}

/// Every font family the theme defines (fallback fonts such as the Japanese fonts are added to each
/// of them).
pub fn font_families() -> Vec<FontFamily> {
    vec![FontFamily::Proportional, FontFamily::Monospace, FontFamily::Name("semibold".into()), FontFamily::Name("medium".into())]
}

/// Install the Latin UI fonts, Chinese fallback (craft-fonts or an installed face), Japanese
/// craft-fonts and egui visuals. Document names keep their glyphs in every interface language.
pub fn install(ctx: &egui::Context, t: &Tokens) {
    let mut fonts = FontDefinitions::default();
    fonts.font_data.insert("inter".into(), Arc::new(FontData::from_static(filmcraft_text::fonts::INTER_REGULAR)));
    fonts.font_data.insert("inter-medium".into(), Arc::new(FontData::from_static(filmcraft_text::fonts::INTER_MEDIUM)));
    fonts.font_data.insert("inter-semibold".into(), Arc::new(FontData::from_static(filmcraft_text::fonts::INTER_SEMIBOLD)));
    fonts.font_data.insert("jbmono".into(), Arc::new(FontData::from_static(filmcraft_text::fonts::JETBRAINS_MONO_REGULAR)));
    fonts.families.entry(FontFamily::Proportional).or_default().insert(0, "inter".into());
    fonts.families.entry(FontFamily::Monospace).or_default().insert(0, "jbmono".into());
    fonts.families.insert(FontFamily::Name("semibold".into()), vec!["inter-semibold".into(), "inter".into()]);
    fonts.families.insert(FontFamily::Name("medium".into()), vec!["inter-medium".into(), "inter".into()]);
    // Japanese before Chinese: the two share code points, and Japanese text must keep Japanese
    // glyph forms; Chinese faces still cover the hanzi Japanese fonts lack
    add_craft_fonts(&mut fonts);
    crate::cjk::install(&mut fonts);
    ctx.set_fonts(fonts);
    apply_visuals(ctx, t);
}

/// Name of the egui font for a craft-fonts entry.
fn craft_font_name(f: &filmcraft_text::fonts::CraftFont) -> String {
    format!("craft:{} {}", f.family, f.style)
}

/// Append the Japanese craft-fonts (empty unless built with `CRAFT_FONTS_DIR`) as the last fallbacks
/// of every font family, after the app's own fonts: BIZ UDPGothic first (bold before regular in
/// the "semibold" and "medium" families), then the other Japanese faces.
fn add_craft_fonts(fonts: &mut FontDefinitions) {
    let jpan: Vec<_> = filmcraft_text::fonts::craft_japanese().collect();
    for f in &jpan {
        fonts.font_data.insert(craft_font_name(f), Arc::new(FontData::from_static(f.bytes)));
    }
    for (family, stack) in fonts.families.iter_mut() {
        let heavy = matches!(family, FontFamily::Name(n) if matches!(n.as_ref(), "semibold" | "medium"));
        let mut order = jpan.clone();
        order.sort_by_key(|f| (!f.family.contains("Gothic"), (f.style == "Bold") != heavy));
        stack.extend(order.iter().map(|f| craft_font_name(f)));
    }
}

pub fn apply_visuals(ctx: &egui::Context, t: &Tokens) {
    let mut v = if t.kind == ThemeKind::Light { Visuals::light() } else { Visuals::dark() };
    v.panel_fill = t.panel_bg;
    v.window_fill = t.panel_bg;
    v.extreme_bg_color = t.field_bg;
    v.faint_bg_color = t.row_alt;
    v.override_text_color = Some(t.text);
    let shway = t.kind == ThemeKind::Shway;
    v.selection.bg_fill = t.accent_muted;
    // Shway: the mint is the focus ring of text fields and the mark of selected items
    v.selection.stroke = Stroke::new(1.0, if shway { t.focus } else { Color32::WHITE });
    v.hyperlink_color = if shway { t.focus } else { t.accent };
    v.window_stroke = Stroke::new(1.0, if shway { t.separator } else { t.field_border });
    let window_radius = if shway { 10 } else { 6 };
    v.window_corner_radius = egui::CornerRadius::same(window_radius);
    v.menu_corner_radius = egui::CornerRadius::same(window_radius);
    v.popup_shadow = if shway {
        egui::epaint::Shadow { offset: [0, 8], blur: 24, spread: 0, color: Color32::from_black_alpha(160) }
    } else {
        egui::epaint::Shadow { offset: [0, 4], blur: 16, spread: 0, color: Color32::from_black_alpha(140) }
    };
    v.window_shadow = v.popup_shadow;
    for w in [&mut v.widgets.noninteractive, &mut v.widgets.inactive, &mut v.widgets.hovered, &mut v.widgets.active, &mut v.widgets.open] {
        w.corner_radius = egui::CornerRadius::same(t.radius_sm as u8);
    }
    v.widgets.noninteractive.bg_fill = t.panel_bg;
    v.widgets.noninteractive.weak_bg_fill = t.panel_bg;
    v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, t.separator);
    v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, t.text);
    v.widgets.inactive.bg_fill = t.field_bg;
    v.widgets.inactive.weak_bg_fill = t.field_bg;
    // Shway: soft, borderless controls; the surface step alone separates them
    v.widgets.inactive.bg_stroke = if shway { Stroke::NONE } else { Stroke::new(1.0, t.field_border) };
    v.widgets.inactive.fg_stroke = Stroke::new(1.0, t.text);
    v.widgets.hovered.bg_fill = t.hover;
    v.widgets.hovered.weak_bg_fill = t.hover;
    v.widgets.hovered.bg_stroke = Stroke::new(1.0, t.field_border);
    v.widgets.hovered.fg_stroke = Stroke::new(1.0, t.tab_text_active);
    v.widgets.active.bg_fill = t.pressed;
    v.widgets.active.weak_bg_fill = t.pressed;
    v.widgets.active.fg_stroke = Stroke::new(1.0, t.tab_text_active);
    v.widgets.open.bg_fill = t.hover;
    v.widgets.open.weak_bg_fill = t.hover;
    if shway {
        v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, t.separator);
        v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, t.text_dim);
        v.widgets.inactive.fg_stroke = Stroke::new(1.0, t.text_dim);
        v.widgets.hovered.bg_stroke = Stroke::NONE;
        v.widgets.active.bg_stroke = Stroke::new(1.0, t.focus);
        v.widgets.open.bg_stroke = Stroke::NONE;
        v.slider_trailing_fill = true;
        v.handle_shape = egui::style::HandleShape::Circle;
    }
    ctx.set_visuals(v);
    ctx.global_style_mut(|s| {
        s.spacing.item_spacing = if shway { egui::vec2(8.0, 6.0) } else { egui::vec2(6.0, 4.0) };
        s.spacing.button_padding = if shway { egui::vec2(10.0, 4.0) } else { egui::vec2(8.0, 3.0) };
        s.spacing.interact_size.y = if shway { 26.0 } else { 24.0 };
        s.spacing.menu_margin = egui::Margin::same(if shway { 6 } else { 4 });
        s.text_styles.insert(TextStyle::Body, FontId::new(12.0, FontFamily::Proportional));
        s.text_styles.insert(TextStyle::Button, FontId::new(12.0, FontFamily::Proportional));
        s.text_styles.insert(TextStyle::Small, FontId::new(11.0, FontFamily::Proportional));
        s.text_styles.insert(TextStyle::Heading, FontId::new(15.0, FontFamily::Name("semibold".into())));
        s.text_styles.insert(TextStyle::Monospace, FontId::new(12.0, FontFamily::Monospace));
        s.animation_time = 0.12;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const JAPANESE: &str = "日本語の文字";

    fn installed() -> egui::Context {
        let ctx = egui::Context::default();
        install(&ctx, &Tokens::for_kind(ThemeKind::default()));
        let mut out = ctx.run_ui(egui::RawInput::default(), |_| {});
        out.textures_delta.clear();
        ctx
    }

    /// Chinese media and track names must render even when the interface stays in English.
    /// Compare the rasterized glyphs with the missing-glyph box, including custom weight families.
    #[test]
    fn chinese_names_render_in_every_theme_and_font_family() {
        const CHINESE: &str = "中文旁白音乐声轨测试简体汉语繁體漢語车";
        filmcraft_text::fonts::scan_system();
        let available = filmcraft_text::fonts::all_faces()
            .iter()
            .any(|f| matches!(f.info.origin, "system" | filmcraft_text::fonts::CRAFT_ORIGIN) && CHINESE.chars().all(|c| f.has_char(c)));
        if !available {
            eprintln!("SKIPPED: no craft-fonts or installed Chinese font");
            return;
        }
        let ctx = egui::Context::default();
        for kind in [ThemeKind::Shway, ThemeKind::Dark, ThemeKind::Medium, ThemeKind::Light] {
            install(&ctx, &Tokens::for_kind(kind));
            ctx.run_ui(egui::RawInput::default(), |_| {}).textures_delta.clear();
            ctx.fonts_mut(|fonts| {
                for family in font_families() {
                    let font = FontId::new(13.0, family);
                    let missing = fonts.layout_no_wrap("\u{fffd}".into(), font.clone(), Color32::WHITE);
                    let missing_uv = missing.rows[0].glyphs[0].uv_rect;
                    let names = fonts.layout_no_wrap(CHINESE.into(), font.clone(), Color32::WHITE);
                    assert_eq!(names.rows.iter().map(|r| r.glyphs.len()).sum::<usize>(), CHINESE.chars().count());
                    for glyph in names.rows.iter().flat_map(|r| &r.glyphs) {
                        assert!(!glyph.uv_rect.is_nothing(), "empty {} in {font:?}", glyph.chr);
                        assert_ne!(glyph.uv_rect, missing_uv, "missing {} in {kind:?} / {font:?}", glyph.chr);
                    }
                }
            });
        }
        // the layouts above put glyphs in the atlas: take that update so it isn't dropped unapplied
        ctx.run_ui(egui::RawInput::default(), |_| {}).textures_delta.clear();
    }

    /// Built with craft-fonts: every font family ends with the Japanese faces (BIZ UDPGothic
    /// first), and Japanese text gets real glyphs, not the replacement box.
    #[test]
    fn japanese_renders_with_craft_fonts() {
        if filmcraft_text::fonts::craft_japanese().next().is_none() {
            eprintln!("SKIPPED: built without craft-fonts (set CRAFT_FONTS_DIR to run)");
            return;
        }
        let ctx = installed();
        ctx.fonts_mut(|fonts| {
            let defs = fonts.definitions().clone();
            for (family, stack) in &defs.families {
                let first = stack.iter().position(|n| n.starts_with("craft:")).unwrap_or(stack.len());
                assert!(first > 0 && stack[first..].iter().all(|n| n.starts_with("craft:")), "{family:?}: {stack:?}");
                let first_japanese = stack.iter().find(|n| n.starts_with("craft:BIZ") || n.starts_with("craft:Shippori"));
                assert!(first_japanese.is_some_and(|n| n.starts_with("craft:BIZ UDPGothic")), "{family:?}: {stack:?}");
            }
            for family in [FontFamily::Proportional, FontFamily::Monospace] {
                let font = FontId::new(13.0, family);
                for ch in JAPANESE.chars() {
                    assert!(fonts.has_glyph(&font, ch), "missing {ch} in {font:?}");
                }
            }
        });
        // laid out and drawn: the replacement box (U+FFFD) would show as one glyph per character
        // from the fallback face; a real face gives each character its own width
        let galley = ctx.fonts_mut(|f| f.layout_no_wrap(JAPANESE.into(), FontId::new(13.0, FontFamily::Proportional), Color32::WHITE));
        assert_eq!(galley.rows.iter().map(|r| r.glyphs.len()).sum::<usize>(), JAPANESE.chars().count());
        assert!(galley.size().x > 13.0 * 4.0, "{:?}", galley.size());
    }

    /// WCAG relative-luminance contrast ratio.
    fn contrast(a: Color32, b: Color32) -> f32 {
        let lum = |c: Color32| {
            let lin = |v: u8| {
                let s = f32::from(v) / 255.0;
                if s <= 0.040_45 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
            };
            0.2126 * lin(c.r()) + 0.7152 * lin(c.g()) + 0.0722 * lin(c.b())
        };
        let (x, y) = (lum(a), lum(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    /// Shway's text tokens meet WCAG AA (4.5:1) on every surface they sit on; disabled text is
    /// exempt but stays >= 3:1 on panels; the accent stays visible (3:1) and white labels on it AA.
    #[test]
    fn shway_text_contrast_meets_wcag_aa() {
        let t = Tokens::for_kind(ThemeKind::Shway);
        let surfaces = [("app", t.app_bg), ("panel", t.panel_bg), ("field", t.field_bg), ("hover", t.hover), ("selection", t.row_selected)];
        for (name, fg) in [("text", t.text), ("text_dim", t.text_dim), ("tab_text", t.tab_text), ("menu", MENU_TEXT), ("focus", t.focus)] {
            for (sname, bg) in surfaces {
                let r = contrast(fg, bg);
                assert!(r >= 4.5, "{name} on {sname}: {r:.2}");
            }
        }
        for (sname, bg) in [("app", t.app_bg), ("panel", t.panel_bg), ("field", t.field_bg)] {
            assert!(contrast(t.text_faint, bg) >= 3.0, "text_faint on {sname}");
            assert!(contrast(t.playhead, bg) >= 3.0, "playhead on {sname}");
            assert!(contrast(t.danger, bg) >= 4.5, "danger on {sname}");
        }
        for (name, bg) in [("accent", t.accent), ("accent_hover", t.accent_hover)] {
            let r = contrast(Color32::WHITE, bg);
            assert!(r >= 4.5, "white on {name}: {r:.2}");
        }
        // the stock highlight colour does not repaint Shway in Premiere-like blue
        let stock = filmcraft_engine::settings::parse_hex(filmcraft_engine::settings::DEFAULT_HIGHLIGHT);
        assert_eq!(t.with_appearance(stock, false).accent, t.accent);
        assert_ne!(t.with_appearance(Some([200, 40, 120]), false).accent, t.accent);
        assert_eq!(ThemeKind::from_pref("darkest"), ThemeKind::Dark);
        assert_eq!(ThemeKind::from_pref(ThemeKind::default().pref_name()), ThemeKind::Shway);
    }

    /// Latin text keeps its UI faces, with or without craft-fonts and system Chinese fonts.
    #[test]
    fn works_without_craft_fonts() {
        let ctx = installed();
        let n = filmcraft_text::fonts::craft_japanese().count() + crate::cjk::craft_fonts().count();
        ctx.fonts_mut(|fonts| {
            let defs = fonts.definitions().clone();
            assert_eq!(defs.font_data.keys().filter(|k| k.starts_with("craft:")).count(), n);
            assert_eq!(defs.families[&FontFamily::Proportional].first().map(String::as_str), Some("inter"));
            assert_eq!(defs.families[&FontFamily::Monospace].first().map(String::as_str), Some("jbmono"));
            assert!(fonts.has_glyph(&FontId::new(13.0, FontFamily::Proportional), 'A'));
            if n == 0 {
                assert!(defs.families.values().flatten().all(|name| !name.starts_with("craft:")));
            }
        });
    }
}
