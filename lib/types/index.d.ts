import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

/** Plugin version read from the package manifest. */
export declare const PLUGIN_VERSION: string;
/** Cordis plugin name used by loader diagnostics. */
export declare const name: 'xiaoai';
/** Required host-plane services. */
export declare const inject: readonly string[];
/** Entry config schema. */
export declare const Config: ReturnType<typeof z.object>;
/** Resolve the settings namespace this plugin's card is keyed by. */
export declare function settingsNamespace(ctx: Context): string;
/** Split the wake-word field into individual keywords. */
export declare function parseWakeKeywords(text: string): string[];
/** Default interpreter inside the bridge virtual environment. */
export declare function defaultPythonPath(bridgeDir: string): string;
/** Plugin entry point. */
export declare function apply(ctx: Context, config?: Record<string, unknown>): void;
