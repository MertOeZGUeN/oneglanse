import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type SystemBrowserEngine = "chromium" | "firefox";

export type ResolvedSystemBrowser = {
	engine: SystemBrowserEngine;
	executablePath: string;
	label: string;
};

type Candidate = {
	engine: SystemBrowserEngine;
	label: string;
	executablePath: string | undefined;
};

function inferEngine(executablePath: string): SystemBrowserEngine {
	return path.basename(executablePath).toLowerCase().includes("firefox")
		? "firefox"
		: "chromium";
}

function existingCandidate(candidate: Candidate): ResolvedSystemBrowser | null {
	const executablePath = candidate.executablePath?.trim();
	if (!executablePath || !existsSync(executablePath)) return null;
	return {
		engine: candidate.engine,
		executablePath,
		label: candidate.label,
	};
}

function resolveConfiguredBrowser(): ResolvedSystemBrowser | null {
	const configured = process.env.ONEGLANSE_SYSTEM_BROWSER_EXECUTABLE?.trim();
	if (!configured) return null;
	if (!existsSync(configured)) {
		throw new Error(
			`ONEGLANSE_SYSTEM_BROWSER_EXECUTABLE does not exist: ${configured}`,
		);
	}
	return {
		engine: inferEngine(configured),
		executablePath: configured,
		label: "configured system browser",
	};
}

function windowsCandidates(): Candidate[] {
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	const localAppData = process.env.LOCALAPPDATA;
	return [
		{
			engine: "chromium",
			label: "Microsoft Edge",
			executablePath: programFilesX86
				? path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
				: undefined,
		},
		{
			engine: "chromium",
			label: "Microsoft Edge",
			executablePath: programFiles
				? path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
				: undefined,
		},
		{
			engine: "chromium",
			label: "Microsoft Edge",
			executablePath: localAppData
				? path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
				: undefined,
		},
		{
			engine: "chromium",
			label: "Google Chrome",
			executablePath: programFiles
				? path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe")
				: undefined,
		},
		{
			engine: "chromium",
			label: "Google Chrome",
			executablePath: programFilesX86
				? path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
				: undefined,
		},
		{
			engine: "chromium",
			label: "Google Chrome",
			executablePath: localAppData
				? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
				: undefined,
		},
		{
			engine: "firefox",
			label: "Mozilla Firefox",
			executablePath: programFiles
				? path.join(programFiles, "Mozilla Firefox", "firefox.exe")
				: undefined,
		},
	];
}

function macCandidates(): Candidate[] {
	return [
		{
			engine: "chromium",
			label: "Google Chrome",
			executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		},
		{
			engine: "chromium",
			label: "Microsoft Edge",
			executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		},
		{
			engine: "firefox",
			label: "Mozilla Firefox",
			executablePath: "/Applications/Firefox.app/Contents/MacOS/firefox",
		},
	];
}

function resolveFromPath(): ResolvedSystemBrowser | null {
	const commands =
		process.platform === "win32"
			? ["msedge.exe", "chrome.exe", "firefox.exe"]
			: ["microsoft-edge", "google-chrome", "chromium", "chromium-browser", "firefox"];
	const locator = process.platform === "win32" ? "where.exe" : "which";

	for (const command of commands) {
		try {
			const stdout = execFileSync(locator, [command], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
			const executablePath = stdout
				.split(/\r?\n/)
				.map((value) => value.trim())
				.find((value) => value && existsSync(value));
			if (!executablePath) continue;
			return {
				engine: inferEngine(executablePath),
				executablePath,
				label: path.basename(executablePath),
			};
		} catch {}
	}
	return null;
}

export function resolveSystemBrowser(): ResolvedSystemBrowser {
	const configured = resolveConfiguredBrowser();
	if (configured) return configured;

	const candidates =
		process.platform === "win32"
			? windowsCandidates()
			: process.platform === "darwin"
				? macCandidates()
				: [];

	for (const candidate of candidates) {
		const resolved = existingCandidate(candidate);
		if (resolved) return resolved;
	}

	const fromPath = resolveFromPath();
	if (fromPath) return fromPath;

	throw new Error(
		"No supported installed browser was found. Install Microsoft Edge, Google Chrome, or Firefox, or set ONEGLANSE_SYSTEM_BROWSER_EXECUTABLE to an existing browser executable.",
	);
}
