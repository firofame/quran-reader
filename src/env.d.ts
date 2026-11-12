/**
 * The bindings the Worker reads at runtime.
 *
 * `worker-configuration.d.ts` is generated from the Wrangler configuration and
 * cannot know about secrets, so the ElevenLabs key is declared here. It is
 * stored as a Worker secret and never reaches the browser.
 */
interface Env {
	ELEVENLABS_API_KEY: string;
}
