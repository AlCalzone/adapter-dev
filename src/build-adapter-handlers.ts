/** Build script to use esbuild without specifying 1000 CLI options */
import { gray, green, red } from "ansi-colors";
import type {
	BuildOptions as ESBuildOptions,
	BuildResult,
	Format,
} from "esbuild";
import { build } from "esbuild";
import execa, { ExecaChildProcess } from "execa";
import path from "path";
import glob from "tiny-glob";
import { die } from "./util";

interface BuildOptions {
	pattern: string;
	tsConfig: string;
	bundle: boolean;
	splitting?: boolean;
	format?: Format;
	compileTarget: string;
	rootDir: string;
	outDir: string;
	watchDir?: string;
}

function findTsc(): string {
	try {
		const packageJsonPath = require.resolve("typescript/package.json");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const packageJson = require(packageJsonPath);
		const binPath = packageJson.bin.tsc;
		return path.join(path.dirname(packageJsonPath), binPath);
	} catch (e: any) {
		die(`Could not find tsc executable: ${e.message}`);
	}
}

/** Helper function to determine file paths that serve as input for React builds */
async function getReactFilePaths(reactOptions: BuildOptions): Promise<{
	entryPoints: string[];
	tsConfigPath: string;
}> {
	let entryPoints = await glob(
		`${reactOptions.rootDir}/${reactOptions.pattern}`,
	);
	entryPoints = entryPoints.filter(
		(ep) =>
			!ep.endsWith(".d.ts") &&
			!ep.endsWith(".test.ts") &&
			!ep.endsWith(".test.tsx"),
	);

	const tsConfigPath = `${reactOptions.rootDir}/${reactOptions.tsConfig}`;
	return { entryPoints, tsConfigPath };
}

/** Helper function to determine file paths that serve as input for TypeScript builds */
async function getTypeScriptFilePaths(
	typescriptOptions: BuildOptions,
): Promise<{
	entryPoints: string[];
	tsConfigPath: string;
}> {
	let entryPoints = await glob(
		`${typescriptOptions.rootDir}/${typescriptOptions.pattern}`,
	);
	entryPoints = entryPoints.filter(
		(ep) => !ep.endsWith(".d.ts") && !ep.endsWith(".test.ts"),
	);
	const tsConfigPath = `${typescriptOptions.rootDir}/${typescriptOptions.tsConfig}`;
	return { entryPoints, tsConfigPath };
}

/** Type-checks the project with the given tsconfig path */
async function typeCheck(tsConfigPath: string): Promise<boolean> {
	console.log();
	console.log(gray(`Type-checking ${tsConfigPath} with tsc...`));
	const tscPath = findTsc();
	try {
		await execa.node(tscPath, `-p ${tsConfigPath} --noEmit`.split(" "), {
			stdout: "inherit",
			stderr: "inherit",
		});
		console.error(green(`✔ Type-checking ${tsConfigPath} succeeded!`));
		return true;
	} catch (e) {
		console.error(red(`❌ Type-checking ${tsConfigPath} failed!`));
		return false;
	}
}

function typeCheckWatch(tsConfigPath: string): ExecaChildProcess {
	console.log();
	console.log(
		gray(`Type-checking ${tsConfigPath} with tsc in watch mode...`),
	);
	const tscPath = findTsc();
	return execa.node(
		tscPath,
		`-p ${tsConfigPath} --noEmit --watch --preserveWatchOutput`.split(" "),
		{
			stdout: "inherit",
			stderr: "inherit",
		},
	);
}

function getReactBuildOptions(
	watch: boolean,
	reactOptions: BuildOptions,
	entryPoints: string[],
	tsConfigPath: string,
): ESBuildOptions {
	return {
		entryPoints,
		tsconfig: tsConfigPath,
		outdir: `${reactOptions.rootDir}/${
			(watch && reactOptions.watchDir) || reactOptions.outDir
		}`,
		bundle: reactOptions.bundle,
		format: reactOptions.format,
		// Splitting moves common code from multiple entry points into separate files
		// This is only relevant for React builds with output format ESM though
		splitting:
			!watch &&
			entryPoints.length > 1 &&
			reactOptions.splitting &&
			reactOptions.bundle &&
			reactOptions.format === "esm",
		target: reactOptions.compileTarget,
		minify: !watch,
		sourcemap: true,
		logLevel: "info",
		define: {
			"process.env.NODE_ENV": watch ? '"development"' : '"production"',
		},
	};
}

function getTypeScriptBuildOptions(
	typescriptOptions: BuildOptions,
	entryPoints: string[],
	tsConfigPath: string,
): ESBuildOptions {
	return {
		entryPoints,
		tsconfig: tsConfigPath,
		outdir: `${typescriptOptions.rootDir}/${typescriptOptions.outDir}`,
		bundle: typescriptOptions.bundle,
		minify: false,
		sourcemap: true,
		logLevel: "info",
		platform: "node",
		format: typescriptOptions.format || "cjs",
		target: typescriptOptions.compileTarget,
	};
}

async function buildReact(options: BuildOptions): Promise<void> {
	const { entryPoints, tsConfigPath } = await getReactFilePaths(options);

	// Building React happens in one or two steps:
	// 1. fast compile with ESBuild
	console.log();
	console.log(gray("Compiling React with ESBuild..."));
	await build(
		getReactBuildOptions(false, options, entryPoints, tsConfigPath),
	);

	// 2. type-check with TypeScript (if there are TSX entry points)
	if (entryPoints.some((e) => e.endsWith(".tsx"))) {
		if (!(await typeCheck(tsConfigPath))) {
			process.exit(1);
		}
	}
}

async function buildTypeScript(options: BuildOptions): Promise<void> {
	const { entryPoints, tsConfigPath } = await getTypeScriptFilePaths(options);

	// Building TS happens in two steps:
	// 1. fast compile with ESBuild
	console.log();
	console.log(gray("Compiling TypeScript with ESBuild..."));
	await build(getTypeScriptBuildOptions(options, entryPoints, tsConfigPath));

	// 2. type-check with TypeScript
	if (!(await typeCheck(tsConfigPath))) {
		process.exit(1);
	}
}

async function buildAll(
	reactOptions: BuildOptions,
	typescriptOptions: BuildOptions,
): Promise<void> {
	await Promise.all([
		buildReact(reactOptions),
		buildTypeScript(typescriptOptions),
	]);
}

async function watchReact(options: BuildOptions): Promise<{
	build: BuildResult;
	check?: ExecaChildProcess;
}> {
	const { entryPoints, tsConfigPath } = await getReactFilePaths(options);

	// Building React happens in one or two steps:
	// 1. fast compile with ESBuild
	console.log();
	console.log(gray("Compiling React with ESBuild in watch mode..."));
	const buildProcess = await build({
		...getReactBuildOptions(true, options, entryPoints, tsConfigPath),
		// We could run a separate type checking process after each successful
		// watch build, but keeping the process alive decreases the check time
		watch: true,
	});

	// 2. type-check with TypeScript (if there are TSX entry points)
	let checkProcess: ExecaChildProcess | undefined;
	if (entryPoints.some((e) => e.endsWith(".tsx"))) {
		checkProcess = typeCheckWatch(tsConfigPath);
	}
	return {
		build: buildProcess,
		check: checkProcess,
	};
}

async function watchTypeScript(options: BuildOptions): Promise<{
	build: BuildResult;
	check: ExecaChildProcess;
}> {
	const { entryPoints, tsConfigPath } = await getTypeScriptFilePaths(options);

	// Building TS happens in two steps:
	// 1. fast compile with ESBuild
	console.log();
	console.log(gray("Compiling TypeScript with ESBuild..."));
	const buildProcess = await build({
		...getTypeScriptBuildOptions(options, entryPoints, tsConfigPath),
		// We could run a separate type checking process after each successful
		// watch build, but keeping the process alive decreases the check time
		watch: true,
	});

	// 2. type-check with TypeScript
	const checkProcess = typeCheckWatch(tsConfigPath);
	return {
		build: buildProcess,
		check: checkProcess,
	};
}

// Entry points for the CLI
export async function handleBuildReactCommand(
	watch: boolean,
	options: BuildOptions,
): Promise<void> {
	if (watch) {
		// In watch mode, we start the ESBuild and TSC processes in parallel and wait until they end

		const { build, check } = await watchReact(options);

		return new Promise((resolve) => {
			check?.then(() => resolve()).catch(() => resolve());
			process.on("SIGINT", () => {
				console.log();
				console.log(gray("SIGINT received, shutting down..."));
				build.stop?.();
				if (check) {
					check.kill("SIGINT");
				} else {
					resolve();
				}
			});
		});
	} else {
		await buildReact(options);
	}
}

export async function handleBuildTypeScriptCommand(
	watch: boolean,
	options: BuildOptions,
): Promise<void> {
	if (watch) {
		// In watch mode, we start the ESBuild and TSC processes in parallel and wait until they end

		const { build, check } = await watchTypeScript(options);

		return new Promise((resolve) => {
			check.then(() => resolve()).catch(() => resolve());
			process.on("SIGINT", () => {
				console.log();
				console.log(gray("SIGINT received, shutting down..."));
				build.stop?.();
				check.kill("SIGINT");
			});
		});
	} else {
		await buildTypeScript(options);
	}
}

export async function handleBuildAllCommand(
	watch: boolean,
	reactOptions: BuildOptions,
	typescriptOptions: BuildOptions,
): Promise<void> {
	if (watch) {
		// In watch mode, we start the ESBuild and TSC processes in parallel and wait until they end

		const { build: buildReact, check: checkReact } = await watchReact(
			reactOptions,
		);
		const { build: buildTS, check: checkTS } = await watchTypeScript(
			typescriptOptions,
		);

		return new Promise((resolve) => {
			Promise.all([checkReact, checkTS].filter(Boolean))
				.then(() => resolve())
				.catch(() => resolve());

			process.on("SIGINT", () => {
				console.log();
				console.log(gray("SIGINT received, shutting down..."));
				buildReact.stop?.();
				buildTS.stop?.();
				checkReact?.kill("SIGINT");
				checkTS.kill("SIGINT");
			});
		});
	} else {
		await buildAll(reactOptions, typescriptOptions);
	}
}
