import { configureDockerlessVisibilityEnv } from "./bootstrap.js";

configureDockerlessVisibilityEnv();
await import("../auth/cli.js");
