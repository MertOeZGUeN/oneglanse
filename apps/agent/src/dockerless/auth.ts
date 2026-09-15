import { configureDockerlessVisibilityEnv } from "./bootstrap.js";

configureDockerlessVisibilityEnv();
await import("../auth/systemCli.js");
