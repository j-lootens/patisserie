import * as vscode from 'vscode';

/** A bottom-panel webview with an ASCII beach: waves of varying reach wet the sand, which dries cell by cell, and leave or wash away shells. Just for fun. */
export class BeachViewProvider implements vscode.WebviewViewProvider {
	static readonly viewId = 'patisserie.beach';

	resolveWebviewView(view: vscode.WebviewView): void {
		const nonce = Math.random().toString(36).slice(2);
		view.webview.options = { enableScripts: true };
		view.webview.html = /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	html, body { margin: 0; height: 100%; overflow: hidden; }
	pre { margin: 0; font: 12px/1.1 var(--vscode-editor-font-family, monospace); white-space: pre; }
	.deep { color: #1e5aa8; } .sea { color: #3b8fd9; } .foam { color: #e8f4ff; } .net { color: #a9cdee; } .net2 { color: #d6e9fb; }
	.w3 { color: #6e5a36; } .w2 { color: #8f7546; } .w1 { color: #b89c62; } .sand { color: #e2c582; }
	.s0 { color: #f0a0a0; } .s1 { color: #f4f0e6; } .s2 { color: #e8b070; }
</style></head>
<body><pre id="beach"></pre>
<script nonce="${nonce}">
	const pre = document.getElementById('beach');
	const probe = document.createElement('span');
	probe.textContent = 'M';
	pre.appendChild(probe);
	const charW = probe.getBoundingClientRect().width || 7;
	const charH = probe.getBoundingClientRect().height || 13;
	pre.removeChild(probe);

	// Fixed pseudo-random sand texture, so the beach doesn't flicker.
	const grain = (x, y) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 97;
	const SHELLS = ['@', 'o', 'e'];

	let cols = 0, rows = 0;
	let wet, dryRate, front, prevFront, drag, shells;
	let waves, newest, last = performance.now();
	const shoreRow = () => rows * 0.3;

	/** (Re)builds the beach for the current panel size. */
	function reset() {
		cols = Math.max(20, Math.floor(window.innerWidth / charW));
		rows = Math.max(8, Math.floor(window.innerHeight / charH));
		wet = new Float32Array(cols * rows);
		// Each cell dries at its own rate; higher up the beach drains faster.
		dryRate = new Float32Array(cols * rows);
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				dryRate[y * cols + x] = (0.03 + Math.random() * 0.08) * (0.5 + y / rows);
			}
		}
		front = new Float32Array(cols).fill(shoreRow());
		prevFront = new Float32Array(front);
		drag = new Float32Array(front);
		shells = new Map();
		newest = newWave(performance.now());
		waves = [newest];
	}

	/**
	 * A wave starts far out, runs up the beach to its own peak, then drains back
	 * below the waterline and dies. The next one starts while it drains.
	 */
	function newWave(start) {
		return {
			start,
			inMs: 1400 + Math.random() * 2400,
			outMs: 3500 + Math.random() * 3000,
			from: shoreRow() * (0.1 + Math.random() * 0.3),
			peak: shoreRow() + (0.2 + Math.random() * 0.45) * rows,
			to: shoreRow() * 0.8,
			next: nextGap(),
			seed: Math.random() * 100,
		};
	}

	/**
	 * When the next wave starts, as a fraction of this wave's drain time: sometimes a
	 * quick set, mostly a normal gap, sometimes a lull after the beach has drained.
	 */
	function nextGap() {
		const r = Math.random();
		return r < 0.25 ? 0.05 + Math.random() * 0.2
			: r < 0.8 ? 0.3 + Math.random() * 0.5
			: 1.1 + Math.random() * 0.8;
	}

	const easeOut = p => 1 - (1 - p) * (1 - p);
	const easeInOut = p => p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);

	/** Front row of wave w at column x, and whether it is still running up. */
	function waveFront(w, x, t) {
		const el = t - w.start;
		const wobble = Math.sin(x * 0.15 + w.seed + t / 4000) * 0.8 + Math.sin(x * 0.05 - t / 6000 + w.seed) * 1.2;
		if (el < w.inMs) {
			// The middle of a wave arrives a little before its ends.
			const lag = Math.abs(x / cols - 0.5) * 0.15 * Math.sin(w.seed);
			const p = Math.min(1, Math.max(0, el / w.inMs - lag));
			return { y: w.from + (w.peak - w.from) * easeOut(p) + wobble, breaking: true };
		}
		const p = Math.min(1, (el - w.inMs) / w.outMs);
		return { y: w.peak - (w.peak - w.to) * easeInOut(p) + wobble, breaking: false };
	}

	function step(t, dt) {
		if (t - newest.start > newest.inMs + newest.outMs * newest.next) {
			newest = newWave(t);
			waves.push(newest);
		}
		// A wave is gone once it has drained, or once a newer wave has washed over it.
		const avgFront = w => {
			let sum = 0;
			for (let x = 0; x < cols; x += 4) {
				sum += waveFront(w, x, t).y;
			}
			return sum;
		};
		waves = waves.filter((w, k) => t - w.start < w.inMs + w.outMs
			&& !waves.slice(k + 1).some(n => avgFront(n) >= avgFront(w)));
		for (let x = 0; x < cols; x++) {
			prevFront[x] = front[x];
			front[x] = Math.max(shoreRow() * 0.8, ...waves.map(w => waveFront(w, x, t).y));
			const retreating = front[x] < prevFront[x];
			// The water surface follows the front with a lag, so its texture is dragged along behind it.
			drag[x] += (front[x] - drag[x]) * Math.min(1, dt * 1.5);
			for (let y = Math.floor(shoreRow() * 0.6); y < rows; y++) {
				const i = y * cols + x;
				if (y < front[x]) {
					wet[i] = 1;
					// Covered shells are rolled down the beach or carried off.
					const shell = shells.get(i);
					if (shell !== undefined && Math.random() < dt * 0.6) {
						shells.delete(i);
						if (!retreating && y + 1 < rows && Math.random() < 0.5) {
							shells.set(i + cols, shell);
						}
					}
				} else {
					wet[i] = Math.max(0, wet[i] - dryRate[i] * dt);
					// The retreating water leaves shells on the line it just uncovered.
					if (retreating && y < prevFront[x] && Math.random() < 0.004) {
						shells.set(i, Math.floor(Math.random() * SHELLS.length));
					}
				}
			}
		}
	}

	/** Thickness of a wave's foam band at column x: lumpy along the front, fat while breaking. */
	function foamDepth(w, x, t, breaking) {
		const lumps = 0.5 + 0.5 * Math.sin(x * 0.27 + w.seed + t / 700) * Math.sin(x * 0.09 - t / 1500 + w.seed * 2);
		return 1 + lumps * (breaking ? 3.5 : 2.2) + (grain(x, 7) % 3) * 0.3;
	}

	/** Dithered foam: dense at d = 0, sparse at d = 1, with per-cell speckle. */
	function dither(d, g) {
		const v = d + (g % 5) * 0.08 - 0.16;
		return v < 0.3 ? '▓' : v < 0.6 ? '▒' : v < 0.85 ? '░' : (g % 2 ? '°' : '·');
	}

	function render(t) {
		const shore = shoreRow();
		let html = '';
		const fronts = [];
		for (let x = 0; x < cols; x++) {
			fronts.push(waves.map(w => {
				const f = waveFront(w, x, t);
				return { ...f, depth: foamDepth(w, x, t, f.breaking) };
			}));
		}
		for (let y = 0; y < rows; y++) {
			let line = '';
			for (let x = 0; x < cols; x++) {
				const i = y * cols + x;
				const g = grain(x, y);
				let cls, ch;
				// The foam band of any wave that covers this cell; a breaking wave wins.
				let foam;
				for (const f of fronts[x]) {
					if (y < f.y && y >= f.y - f.depth && (!foam || f.breaking)) {
						foam = f;
					}
				}
				if (foam) {
					const d = (foam.y - y) / foam.depth;
					cls = foam.breaking ? 'foam' : 'net2';
					ch = dither(foam.breaking ? d : d * 0.6 + 0.3, g);
				} else if (y < front[x]) {
					// Texture coordinates move with the water: v is the row within the dragged surface.
					const v = y - drag[x] * 0.85;
					const swell = Math.sin(v * 1.1 - t / 700);
					const deep = y < shore * 0.6;
					// A lace of foam: thin lines where crossing ripples cancel out. It is densest
					// just behind the waterline, fades out to sea, and slowly changes shape.
					const near = Math.max(0, 1 - (front[x] - y) / (rows * 0.45));
					const lace = Math.abs(
						Math.sin(x * 0.45 + v * 0.9 + t / 4000)
						+ Math.sin(x * 0.21 - v * 1.3 + 2 - t / 5000)
						+ Math.sin((x + v) * 0.33 + t / 3000),
					);
					const width = 0.1 + near * 0.45;
					if (lace < width) {
						cls = lace < width * 0.4 ? 'net2' : 'net';
						ch = dither(0.5 + (lace / width) * 0.5 - near * 0.2, g);
					} else {
						cls = deep ? 'deep' : 'sea';
						ch = swell > 0.6 ? '^' : swell > -0.2 ? '~' : (deep ? '-' : ' ');
					}
				} else if (shells.has(i)) {
					const kind = shells.get(i);
					cls = 's' + kind;
					ch = SHELLS[kind];
				} else {
					const w = wet[i];
					cls = w > 0.66 ? 'w3' : w > 0.33 ? 'w2' : w > 0.05 ? 'w1' : 'sand';
					ch = w > 0.66 ? (g % 5 ? ':' : '.') : g % 7 ? '.' : ',';
				}
				line += '<span class="' + cls + '">' + ch + '</span>';
			}
			html += line + '\\n';
		}
		pre.innerHTML = html;
	}

	function frame(t) {
		// Don't simulate while the panel is hidden or collapsed; check again shortly.
		if (document.hidden || window.innerHeight < charH * 2 || window.innerWidth < charW * 4) {
			last = t;
			setTimeout(() => requestAnimationFrame(frame), 500);
			return;
		}
		if (Math.floor(window.innerWidth / charW) !== cols || Math.floor(window.innerHeight / charH) !== rows) {
			reset();
		}
		const dt = Math.min(0.25, (t - last) / 1000);
		last = t;
		step(t, dt);
		render(t);
		setTimeout(() => requestAnimationFrame(frame), 80);
	}
	reset();
	requestAnimationFrame(frame);
</script></body></html>`;
	}
}
