import * as assert from 'node:assert';
import { PiSession } from '../sessions/types';
import { formatCost, totalCost } from '../views/format';
import { SessionTreeProvider } from '../views/sessionTreeProvider';

function session(over: Partial<PiSession> = {}): PiSession {
	return {
		id: 'abc',
		filePath: '/tmp/abc.jsonl',
		startTime: new Date('2026-01-01T10:00:00Z'),
		lastActivity: new Date('2026-01-01T11:00:00Z'),
		...over,
	};
}

suite('session view', () => {
	test('formatCost', () => {
		assert.strictEqual(formatCost(0), '$0.00');
		assert.strictEqual(formatCost(1.005), '$1.01');
		assert.strictEqual(formatCost(1.234), '$1.23');
		assert.strictEqual(formatCost(1234567.891), '$1,234,567.89');
		assert.strictEqual(formatCost(undefined), '–');
	});

	test('totalCost', () => {
		assert.strictEqual(totalCost([]), undefined);
		assert.strictEqual(totalCost([session()]), undefined);
		assert.strictEqual(totalCost([session({ cost: 1 }), session({}), session({ cost: 0.5 })]), 1.5);
		assert.strictEqual(totalCost([session({ cost: 0 })]), 0);
	});

	test('getTreeItem', () => {
		const provider = new SessionTreeProvider(undefined);
		const s = session({ name: 'My session', cost: 1.234 });
		const item = provider.getTreeItem(s);
		assert.strictEqual(item.label, 'My session');
		assert.strictEqual(item.description, '$1.23');
		assert.strictEqual(item.id, 'abc');
		assert.strictEqual(item.command?.command, 'patisserie.openSession');
		assert.deepStrictEqual(item.command?.arguments, [s]);
		const noName = provider.getTreeItem(session());
		assert.strictEqual(noName.label, 'abc');
		assert.strictEqual(noName.description, '–');
		provider.dispose();
	});

	test('no workspace gives no children', async () => {
		const provider = new SessionTreeProvider(undefined);
		assert.deepStrictEqual(await provider.getChildren(), []);
		provider.dispose();
	});
});
