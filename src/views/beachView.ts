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
	body { cursor: crosshair; user-select: none; }
	pre { margin: 0; font: 12px/1.1 var(--vscode-editor-font-family, monospace); white-space: pre; }
	.deep { color: #1e5aa8; } .deepG { color: #1d6a78; } .seaG { color: #3aa39a; } .foamG { color: #b9c2c8; } .deep2 { color: #173f78; } .sea { color: #3b8fd9; } .sea2 { color: #7cbcee; } .foam { color: #e8f4ff; } .net { color: #a9cdee; } .net2 { color: #d6e9fb; }
	.w3 { color: #6e5a36; } .w2 { color: #8f7546; } .w1 { color: #b89c62; } .sand { color: #e2c582; } .sandL { color: #efd9a4; } .sandD { color: #c9a868; } .sandG { color: #a99f8a; } .c0 { color: #d9828c; } .c1 { color: #7fa7d6; } .c2 { color: #8fbf7a; } .c3 { color: #e09a5a; } .c4 { color: #b08fd0; }
	.b3 { filter: brightness(0.5); } .b2 { filter: brightness(0.65); } .b1 { filter: brightness(0.82); }
	.groove { color: #6b5230; } .s0 { color: #f0a0a0; } .s1 { color: #f4f0e6; } .s2 { color: #e8b070; }
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
	// A second, independent hash for colour and texture picks.
	const grain2 = (x, y) => ((Math.imul(x + 1, 2654435761) ^ Math.imul(y + 7, 40503)) >>> 0) % 101;
	// Bits and pieces lying in the sand: grit, twigs, pebbles.
	const DEBRIS = ['\`', "'", '~', ';', '"', '*', '°', '-'];
	const SHELLS = ['@', 'o', 'e'];

	let cols = 0, rows = 0;
	let wet, dryRate, seeded, drawn, front, prevFront, drag, shells, rising, marks;
	let waves, newest, last = performance.now();
	// The sea lies above the top edge: waves come in from there and drain back out of view.
	const offshore = () => -rows * 0.15;

	/** (Re)builds the beach for the current panel size. */
	function reset() {
		cols = Math.max(20, Math.floor(window.innerWidth / charW));
		rows = Math.max(8, Math.floor(window.innerHeight / charH));
		wet = new Float32Array(cols * rows);
		// Each cell dries at its own rate; higher up the beach drains faster.
		dryRate = new Float32Array(cols * rows);
		// Cells that dried from a spontaneous seed, or from a seeded neighbour; drying spreads faster from them.
		seeded = new Uint8Array(cols * rows);
		// Lines the user drew in the sand: the character to show per cell, or empty.
		drawn = new Array(cols * rows).fill('');
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				dryRate[y * cols + x] = (0.03 + Math.random() * 0.08) * (0.5 + y / rows);
			}
		}
		front = new Float32Array(cols).fill(offshore());
		prevFront = new Float32Array(front);
		drag = new Float32Array(front);
		rising = new Uint8Array(cols);
		// Foam lines left at the highest point each wave reached: per column, a list of { y, s, rate }.
		marks = Array.from({ length: cols }, () => []);
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
			inMs: 2800 + Math.random() * 2400,
			outMs: 3500 + Math.random() * 3000,
			from: -rows * (0.2 + Math.random() * 0.3),
			peak: (0.3 + Math.random() * 0.5) * rows,
			to: offshore() - 3,
			next: nextGap(),
			inSpread: 0.3 + Math.random() * 0.7,
			outSpread: 0.15 + Math.random() * 0.45,
			reachVar: 0.04 + Math.random() * 0.1,
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

	/** The fastest any part of a wave may run in, so it never shoots up the beach. */
	const MIN_IN_MS = 1800;

	const easeOut = p => 1 - (1 - p) * (1 - p);
	const easeInOut = p => p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);

	/**
	 * How fast a wave moves at column x, between 1 and 1 + spread: a smooth,
	 * per-wave mix of bumps, so some stretches of the beach run ahead.
	 */
	function speedAt(w, x, spread, salt) {
		// Low frequencies only, so faster and slower stretches are broad.
		const n = Math.sin(x * 0.045 + w.seed * salt) * 0.45 + Math.sin(x * 0.083 + w.seed * 3 * salt) * 0.3
			+ Math.sin(x * 0.019 - w.seed * salt) * 0.25;
		return 1 + spread * (0.5 + 0.5 * n);
	}

	/** Stretches of a wave that ran further up the beach than the rest drain back faster. */
	function reachAt(w, x) {
		return rows * w.reachVar * (Math.sin(x * 0.05 + w.seed * 7) + 0.5 * Math.sin(x * 0.09 - w.seed * 4));
	}

	function drainSpeed(w, x) {
		return speedAt(w, x, w.outSpread, 2) * (1 + Math.max(0, reachAt(w, x)) / rows * 5);
	}

	/** Front row of wave w at column x, and whether it is still running up there. */
	function waveFront(w, x, t) {
		const el = t - w.start;
		const wobble = Math.sin(x * 0.07 + w.seed + t / 4000) * 0.6 + Math.sin(x * 0.03 - t / 6000 + w.seed) * 1.2;
		// Faster columns reach their peak sooner and start draining sooner; never faster than MIN_IN_MS.
		const inMs = Math.max(MIN_IN_MS, w.inMs / speedAt(w, x, w.inSpread, 1));
		// Some stretches of the wave run further up the beach than others.
		const peak = w.peak + reachAt(w, x);
		if (el < inMs) {
			const p = el / inMs;
			return { y: w.from + (peak - w.from) * easeOut(p) + wobble, breaking: true };
		}
		// A stretch that ran further drains fast, but only until it has caught up with
		// the rest of the wave; then it moves with the rest instead of overtaking it.
		const drained = (top, speed) => {
			const p = Math.min(1, (el - inMs) / w.outMs * speed);
			return top - (top - w.to) * easeInOut(p);
		};
		const fast = drained(peak, drainSpeed(w, x));
		const rest = drained(Math.min(peak, w.peak), speedAt(w, x, w.outSpread, 2));
		// A soft maximum, so the hand-over from fast to slow is smooth.
		const y = (fast + rest + Math.sqrt((fast - rest) ** 2 + 1)) / 2;
		return { y: y + wobble, breaking: false };
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
			front[x] = Math.max(offshore(), ...waves.map(w => waveFront(w, x, t).y));
			const retreating = front[x] < prevFront[x];
			// Where the water turns back, it leaves a thin line of foam that slowly dries out.
			// Water running over a line washes it away.
			if (retreating && rising[x] && prevFront[x] > 0) {
				// The last row the water covered: the line appears as the water drains off it.
				const y = Math.floor(prevFront[x]);
				// Slowly draining water leaves more foam: a thick line where it pulls back
				// slowly, a fine one where it pulls back quickly.
				const lead = waves.reduce((a, w) => (waveFront(w, x, t).y > waveFront(a, x, t).y ? w : a), waves[0]);
				const drain = lead ? drainSpeed(lead, x) * 4000 / lead.outMs : 1;
				const thick = drain < 0.85 ? 3 : drain < 1.2 ? 2 : 1;
				marks[x] = marks[x].filter(m => Math.abs(m.y - y) > 2);
				marks[x].push({ y, thick, s: 1, rate: 0.02 + Math.random() * 0.03 });
				// The turning water drops what it carried: shells collect along the foam line.
				if (Math.random() < 0.06 && y - thick >= 0 && y < rows) {
					shells.set((y - Math.floor(Math.random() * thick)) * cols + x, Math.floor(Math.random() * SHELLS.length));
				}
			}
			rising[x] = retreating ? 0 : 1;
			// A line is washed away once water runs clearly past it.
			marks[x] = marks[x].filter(m => front[x] < m.y + 1.5 && (m.s -= m.rate * dt) > 0);
			// The water surface follows the front with a lag, so its texture is dragged along behind it.
			drag[x] += (front[x] - drag[x]) * Math.min(1, dt * 1.5);
			for (let y = 0; y < rows; y++) {
				const i = y * cols + x;
				if (y < front[x]) {
					wet[i] = 1;
					seeded[i] = 0;
					// The water smooths out anything drawn in the sand.
					drawn[i] = '';
					// Covered shells are rolled down the beach or carried off.
					const shell = shells.get(i);
					if (shell !== undefined && Math.random() < dt * 0.6) {
						shells.delete(i);
						if (!retreating && y + 1 < rows && Math.random() < 0.5) {
							shells.set(i + cols, shell);
						}
					}
				} else {
					// The retreating water leaves shells on the line it just uncovered.
					if (retreating && y < prevFront[x] && Math.random() < 0.004) {
						shells.set(i, Math.floor(Math.random() * SHELLS.length));
					}
				}
			}
		}
		dry(dt);
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

	const DRY = 0.05;

	/**
	 * Dries the uncovered sand. Wet sand mostly dries from its edges: the more dry
	 * neighbours a cell has, the faster it dries, and faster still next to a seeded
	 * patch. Now and then a dry seed appears in the middle of wet sand.
	 */
	function dry(dt) {
		const before = wet.slice();
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				const i = y * cols + x;
				if (y < front[x] || before[i] <= 0) {
					continue;
				}
				if (before[i] > DRY && Math.random() < dt * 0.0015 * (1.2 - before[i])) {
					wet[i] = 0;
					seeded[i] = 1;
					continue;
				}
				let dryNeighbours = 0;
				let seedNeighbour = 0;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) {
						continue;
					}
					const n = ny * cols + nx;
					if (ny >= front[nx] && before[n] <= DRY) {
						dryNeighbours++;
						seedNeighbour |= seeded[n];
					}
				}
				const spread = (dryNeighbours / 4) * (seedNeighbour ? 1.2 : 0.7);
				wet[i] = Math.max(0, before[i] - (dryRate[i] * 0.4 + spread * dryRate[i] * 6) * dt);
				if (wet[i] <= DRY && seedNeighbour) {
					seeded[i] = 1;
				}
			}
		}
	}

	/** Strength of the foam lines per cell. A thick line grows back toward the water, where it is a little thinner. */
	function markGrid() {
		const grid = new Float32Array(cols * rows);
		for (let x = 0; x < cols; x++) {
			for (const m of marks[x]) {
				for (let k = 0; k < m.thick && m.y - k >= 0; k++) {
					if (m.y >= rows) {
						break;
					}
					const i = (m.y - k) * cols + x;
					grid[i] = Math.max(grid[i], m.s * (1 - k * 0.25));
				}
			}
		}
		return grid;
	}

	function render(t) {
		const lines = markGrid();
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
					cls = foam.breaking ? (grain2(x, y) % 6 ? 'foam' : 'foamG') : (grain2(x, y) % 5 ? 'net2' : 'foamG');
					ch = dither(foam.breaking ? d : d * 0.6 + 0.3, g);
				} else if (y < front[x]) {
					// Texture coordinates move with the water: v is the row within the dragged surface.
					const v = y - drag[x] * 0.85;
					// Layered ripples moving with the water, plus a little per-cell grain.
					const swell = Math.sin(v * 1.1 - t / 700) * 0.5
						+ Math.sin(x * 0.17 + v * 0.6 - t / 2500) * 0.3
						+ Math.sin(x * 0.41 - v * 0.35 + t / 3100) * 0.2
						+ ((g % 7) - 3) * 0.04;
					// Water far behind the front is deeper.
					const deep = front[x] - y > rows * 0.35;
					// A web of foam, like the lace left behind a breaking wave: two crossing ripple
					// fields, with foam where either one cancels out, so the lines enclose dark cells.
					// It is dense in a wide band behind the waterline, then breaks into patches out to sea.
					const near = Math.max(0, 1 - (front[x] - y) / (rows * 0.7));
					const laceA = Math.abs(
						Math.sin(x * 0.45 + v * 0.9 + t / 4000)
						+ Math.sin(x * 0.21 - v * 1.3 + 2 - t / 5000)
						+ Math.sin((x + v) * 0.33 + t / 3000),
					);
					const laceB = Math.abs(
						Math.sin(x * 0.31 - v * 1.1 + 4 - t / 4500)
						+ Math.sin(x * 0.57 + v * 0.7 + 1 + t / 3500)
						+ Math.sin((x - v) * 0.26 - t / 6000),
					);
					const lace = Math.min(laceA, laceB);
					// Broad patches where the foam is thicker or thinner.
					const patch = 0.5 + 0.5 * Math.sin(x * 0.06 + v * 0.15 + t / 7000) * Math.sin(x * 0.023 - v * 0.09 + 3);
					const width = (0.05 + near * near * 0.5) * (0.5 + patch);
					if (lace < width) {
						// Thin glyphs keep it a web of lines; only the core right behind the front is solid.
						const r = lace / width;
						cls = r < 0.4 ? 'net2' : 'net';
						ch = r < 0.25 && near > 0.7 ? '▒' : r < 0.55 ? (g % 3 ? '░' : '°') : (g % 2 ? '·' : '˙');
					} else {
						// Crests catch the light, troughs are darker.
						cls = swell > 0.55 ? (deep ? 'sea' : 'sea2') : swell < -0.45 ? (deep ? 'deep2' : 'deep') : (deep ? 'deep' : 'sea');
						// Loose cells here and there tinted towards green.
						if (grain2(x, y) < 10) {
							cls = cls === 'deep' || cls === 'deep2' ? 'deepG' : 'seaG';
						}
						ch = swell > 0.7 ? '^' : swell > 0.45 ? (g % 3 ? '~' : '≈')
							: swell > 0.15 ? '~' : swell > -0.15 ? (g % 2 ? '-' : '~')
							: swell > -0.45 ? (g % 3 ? '-' : '.') : (g % 4 ? ' ' : '.');
					}
				} else if (drawn[i]) {
					cls = 'groove';
					ch = drawn[i];
				} else if (shells.has(i)) {
					const kind = shells.get(i);
					cls = 's' + kind;
					ch = SHELLS[kind];
				} else if (lines[i] > (grain(x, y + 3) % 10) / 40) {
					// The foam line thins out as it dries: bright and solid first, then a few specks.
					const m = lines[i];
					cls = m > 0.35 ? 'foam' : 'net';
					ch = m > 0.7 ? (g % 3 ? '°' : 'o') : m > 0.35 ? (g % 2 ? '°' : '·') : (g % 2 ? '·' : '˙');
				} else {
					const w = wet[i];
					const g2 = grain2(x, y);
					// Each grain has a fixed colour; wet sand shows the same colours, darkened.
					const tint = g2 < 12 ? 'sandL' : g2 < 24 ? 'sandD' : g2 < 28 ? 'sandG'
						// A few brightly coloured grains.
						: g2 > 94 ? 'c' + (g % 5) : '';
					const level = w > 0.66 ? 3 : w > 0.33 ? 2 : w > 0.05 ? 1 : 0;
					cls = !tint ? (level ? 'w' + level : 'sand') : level ? tint + ' b' + level : tint;
					ch = g2 > 97 ? DEBRIS[g % DEBRIS.length]
						: w > 0.66 ? (g % 5 ? ':' : '.') : g % 7 ? '.' : ',';
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
	// Drawing in the sand: drag the mouse to carve a thin dithered groove.
	let pen;
	function cellAt(e) {
		return { x: Math.floor(e.clientX / charW), y: Math.floor(e.clientY / charH) };
	}
	const DENSITY = { '░': 1, '▒': 2, '▓': 3 };
	function mark(x, y, ch) {
		const i = y * cols + x;
		if (x >= 0 && x < cols && y >= 0 && y < rows && y >= front[x] && (DENSITY[drawn[i]] ?? 0) < DENSITY[ch]) {
			drawn[i] = ch;
		}
	}
	function carve(x, y) {
		mark(x, y, '▓');
		// A fine brush: now and then a faint speck beside the line.
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			if (Math.random() < 0.12) {
				mark(x + dx, y + dy, '░');
			}
		}
	}
	function strokeTo(to) {
		const dx = to.x - pen.x, dy = to.y - pen.y;
		const steps = Math.max(Math.abs(dx), Math.abs(dy));
		for (let k = 1; k <= steps; k++) {
			carve(Math.round(pen.x + dx * k / steps), Math.round(pen.y + dy * k / steps));
		}
		pen = to;
	}
	document.addEventListener('mousedown', e => {
		pen = cellAt(e);
		carve(pen.x, pen.y);
	});
	document.addEventListener('mousemove', e => {
		if (pen && e.buttons & 1) {
			strokeTo(cellAt(e));
		}
	});
	document.addEventListener('mouseup', () => {
		pen = undefined;
	});

	reset();
	requestAnimationFrame(frame);
</script></body></html>`;
	}
}
