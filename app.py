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

        # Downscale for faster processing while keeping aspect ratio
        proc_size = 800
        scale = min(proc_size / orig_w, proc_size / orig_h, 1.0)
        if scale < 1.0:
            proc_img = cv2.resize(img, (int(orig_w * scale), int(orig_h * scale)))
        else:
            proc_img = img
            scale = 1.0

        ph, pw = proc_img.shape[:2]
        gray = cv2.cvtColor(proc_img, cv2.COLOR_BGR2GRAY)

        # CLAHE to improve contrast in varied lighting conditions
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        gray = clahe.apply(gray)
        gray = cv2.GaussianBlur(gray, (9, 9), 2)

        min_r = max(8, int(min(pw, ph) * 0.018))
        max_r = int(min(pw, ph) * 0.13)

        circles = cv2.HoughCircles(
            gray,
            cv2.HOUGH_GRADIENT,
            dp=1.2,
            minDist=int(min(pw, ph) * 0.06),
            param1=50,
            param2=28,
            minRadius=min_r,
            maxRadius=max_r,
        )

        result = []
        if circles is not None:
            for x, y, r in np.round(circles[0]).astype(int):
                result.append({
                    'x': round(int(x) / scale),
                    'y': round(int(y) / scale),
                    'r': round(int(r) / scale),
                })

        return jsonify({'circles': result})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
