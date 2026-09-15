import path from "node:path";

export function configureDockerlessVisibilityEnv(): void {
	process.env.ONEGLANSE_APP_MODE = "local";
	process.env.ONEGLANSE_LOCAL_BROWSER_MODE ||= "system";
	process.env.AGENT_AUTH_ROOT_DIR ||= path.resolve(
		process.cwd(),
		"..",
		"..",
		".oneglanse-storage",
		"auth",
	);

	// The upstream services package creates database/queue clients at module load.
	// Dockerless visibility execution only uses its file-backed auth helpers, so
	// provide valid but deliberately unreachable endpoints to satisfy env parsing
	// without starting PostgreSQL, ClickHouse, or Redis.
	process.env.DATABASE_URL ||= "postgresql://oneglanse:oneglanse@127.0.0.1:9/oneglanse";
	process.env.CLICKHOUSE_URL ||= "http://127.0.0.1:9";
	process.env.REDIS_HOST ||= "127.0.0.1";
	process.env.REDIS_PORT ||= "9";

	process.env.AGENT_AUTH_UPLOAD_URL = "";
	process.env.AGENT_AUTH_UPLOAD_TOKEN = "";
}
