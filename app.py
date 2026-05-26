from flask import Flask, render_template, request, jsonify
import cv2
import numpy as np
import base64
import os

app = Flask(__name__)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/detect', methods=['POST'])
def detect():
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': 'No image provided'}), 400

        img_str = data['image']
        if ',' in img_str:
            img_str = img_str.split(',')[1]

        img_bytes = base64.b64decode(img_str)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({'error': 'Could not decode image'}), 400

        orig_h, orig_w = img.shape[:2]

        proc_size = 800
        scale = min(proc_size / orig_w, proc_size / orig_h, 1.0)
        if scale < 1.0:
            proc_img = cv2.resize(img, (int(orig_w * scale), int(orig_h * scale)))
        else:
            proc_img = img
            scale = 1.0

        ph, pw = proc_img.shape[:2]
        gray = cv2.cvtColor(proc_img, cv2.COLOR_BGR2GRAY)

        # Bilateral filter smooths gravel/stone texture while keeping crisp ball edges,
        # then CLAHE boosts contrast, then a light Gaussian for HoughCircles stability.
        gray = cv2.bilateralFilter(gray, 9, 75, 75)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        gray = clahe.apply(gray)
        blurred = cv2.GaussianBlur(gray, (7, 7), 1.5)

        min_r = max(8, int(min(pw, ph) * 0.02))
        max_r = int(min(pw, ph) * 0.12)
        min_dist = max(min_r * 2, int(min(pw, ph) * 0.06))

        # HOUGH_GRADIENT_ALT (OpenCV ≥4.3) uses a phase-coded accumulator that is far
        # more precise than HOUGH_GRADIENT. param2 is a circularity score 0–1; 0.85
        # keeps only near-perfect circles and eliminates most stone false-positives.
        circles = cv2.HoughCircles(
            blurred,
            cv2.HOUGH_GRADIENT_ALT,
            dp=1.5,
            minDist=min_dist,
            param1=300,
            param2=0.85,
            minRadius=min_r,
            maxRadius=max_r,
        )

        result = []
        if circles is not None:
            for x, y, r in np.round(circles[0]).astype(int):
                cx, cy, cr = int(x), int(y), int(r)
                if _perimeter_has_clear_edge(gray, cx, cy, cr):
                    result.append({
                        'x': round(cx / scale),
                        'y': round(cy / scale),
                        'r': round(cr / scale),
                    })

        return jsonify({'circles': result})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _perimeter_has_clear_edge(gray, cx, cy, r, n_samples=36, min_fraction=0.50, grad_thresh=16):
    """Return True if most sampled points on the circle perimeter sit on a strong gradient.

    Pétanque balls have a continuous, well-defined circular edge; random stone
    clusters that slip past HoughCircles do not.
    """
    h, w = gray.shape
    angles = np.linspace(0, 2 * np.pi, n_samples, endpoint=False)
    xs = np.round(cx + r * np.cos(angles)).astype(int)
    ys = np.round(cy + r * np.sin(angles)).astype(int)

    valid = strong = 0
    for px, py in zip(xs, ys):
        if not (1 <= px < w - 1 and 1 <= py < h - 1):
            continue
        valid += 1
        gx = float(gray[py, px + 1]) - float(gray[py, px - 1])
        gy = float(gray[py + 1, px]) - float(gray[py - 1, px])
        if gx * gx + gy * gy > grad_thresh * grad_thresh:
            strong += 1

    return valid >= n_samples // 2 and strong >= int(valid * min_fraction)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
