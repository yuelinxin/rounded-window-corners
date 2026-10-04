// The CSS actor draws a white fill over a black shadow. In premultiplied
// colors, RGB contains the fill coverage while alpha contains both layers.
// Subtracting the fill leaves only the visible black shadow, including at
// partially sampled edges. A brightness threshold leaves gray/white fringes.
void main() {
    vec4 color = cogl_color_out;
    float fill = max(color.r, max(color.g, color.b));
    // Keep the existing shadow strength where there is no white fill.
    float shadowAlpha = max(color.a - fill, 0.0) * color.a;
    cogl_color_out = vec4(0.0, 0.0, 0.0, shadowAlpha);
}
