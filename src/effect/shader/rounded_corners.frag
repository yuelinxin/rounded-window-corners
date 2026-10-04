// Based on the rounded-corner shader in Mutter's meta-background-content.c.
// All geometry is in actor coordinates; coverage is measured in destination
// pixels so borders stay consistent at fractional scales and in the overview.

// Window bounds: left, top, right, bottom.
uniform vec4 bounds;
uniform float clipRadius;
uniform float borderWidth;
uniform vec4 borderColor;
uniform vec4 borderedAreaBounds;
uniform float borderedAreaClipRadius;
uniform float exponent;

// The vertex shader removes the actor's modelview transform while preserving
// Clutter's FBO scale and offset. Unlike texture coordinates, these coordinates
// refer to the actor's content, excluding the offscreen buffer's padding.
varying vec2 rwcActorPosition;

float getPointOpacity(vec2 p, vec4 rect, float radius, float power) {
    vec2 size = rect.zw - rect.xy;
    if (min(size.x, size.y) <= 0.0)
        return 0.0;

    radius = min(radius, min(size.x, size.y) * 0.5);
    vec2 inset = min(p - rect.xy, rect.zw - p);
    float distance = min(inset.x, inset.y);
    vec2 corner = max(vec2(radius) - inset, vec2(0.0));

    if (min(corner.x, corner.y) > 0.0) {
        float cornerDistance;
        if (power <= 2.0) {
            cornerDistance = length(corner);
        } else {
            // Normalize before exponentiation to avoid overflow for large radii.
            float largest = max(corner.x, corner.y);
            vec2 normalized = corner / largest;
            cornerDistance = largest * pow(
                pow(normalized.x, power) + pow(normalized.y, power),
                1.0 / power);
        }
        distance = radius - cornerDistance;
    }

    // Include partial pixel coverage on straight edges as well as corners.
    // A 1-logical-pixel border at 150% must cover 1.5 physical pixels, rather
    // than jump between one and two fully painted pixels when moved.
    return clamp(distance / max(fwidth(distance), 0.0001) + 0.5, 0.0, 1.0);
}

void main() {
    vec2 p = rwcActorPosition;
    float pointAlpha = getPointOpacity(p, bounds, clipRadius, exponent);

    if (borderWidth > 0.9 || borderWidth < -0.9) {
        // Window pixels already include paint opacity. Fade borders with them.
        vec4 borderPaintColor = vec4(borderColor.rgb, 1.0) * cogl_color_in.a;
        float borderedAreaAlpha = getPointOpacity(
            p, borderedAreaBounds, borderedAreaClipRadius, exponent);

        if (borderWidth > 0.0) {
            float borderAlpha = max(pointAlpha - borderedAreaAlpha, 0.0) * borderColor.a;
            cogl_color_out = cogl_color_out * (pointAlpha - borderAlpha)
                           + borderPaintColor * borderAlpha;
        } else {
            float borderAlpha = max(borderedAreaAlpha - pointAlpha, 0.0) * borderColor.a;
            cogl_color_out = cogl_color_out * pointAlpha
                           + borderPaintColor * borderAlpha;
        }
    } else {
        cogl_color_out *= pointAlpha;
    }
}
