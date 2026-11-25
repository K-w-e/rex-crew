// Thin wrapper around the `rex` CLI.
import { execFile } from "node:child_process";

export interface RexResult {
	stdout: string;
	stderr: string;
	code: number;
}

export function rex(args: string[], timeoutMs = 15000): Promise<RexResult> {
	return new Promise((resolve) => {
		execFile("rex", args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
			resolve({ stdout: String(stdout), stderr: String(stderr), code });
		});
	});
}

export function inRex(): boolean {
	return Boolean(process.env.REX_SESSION && process.env.REX_BLOCK);
}

export interface SplitOptions {
	session: string;
	anchor: string;
	direction: "right" | "below" | "left" | "above";
	ratio?: number;
	label: string;
	cwd: string;
	command: string[];
}

export async function split(o: SplitOptions): Promise<string> {
	const args = ["split", "-s", o.session, "-b", o.anchor, `--split=${o.direction}`, "--focus=false", "--label", o.label, "-c", o.cwd, "--json"];
	if (o.ratio) args.push("--ratio", String(o.ratio));
	args.push("--", ...o.command);
	const r = await rex(args);
	if (r.code !== 0) throw new Error(`rex split failed: ${r.stderr || r.stdout}`);
	const parsed = JSON.parse(r.stdout) as { block_ids?: string[] };
	const id = parsed.block_ids?.[0];
	if (!id) throw new Error(`rex split returned no block id: ${r.stdout}`);
	return id;
}

export async function blockExists(session: string, block: string): Promise<boolean> {
	const r = await rex(["block", "ls", "-s", session, "--json"]);
	if (r.code !== 0) return false;
	try {
		const parsed = JSON.parse(r.stdout) as { blocks?: { block_id: string }[] };
		return Boolean(parsed.blocks?.some((b) => b.block_id === block));
	} catch {
		return false;
	}
}

export async function capture(session: string, block: string): Promise<string> {
	const r = await rex(["capture", "-s", session, "-b", block, "--trim", "--unwrap"], 30000);
	if (r.code !== 0) throw new Error(r.stderr || r.stdout);
	return r.stdout;
}

export async function sendLine(session: string, block: string, text: string): Promise<void> {
	const a = await rex(["send", "-s", session, "-b", block, text]);
	if (a.code !== 0) throw new Error(a.stderr || a.stdout);
	const b = await rex(["send-key", "-s", session, "-b", block, "enter"]);
	if (b.code !== 0) throw new Error(b.stderr || b.stdout);
}

export async function rename(session: string, block: string, label: string): Promise<void> {
	await rex(["block", "rename", "-s", session, block, label], 5000);
}

export async function close(session: string, block: string): Promise<void> {
	await rex(["block", "close", "-s", session, block]);
}
