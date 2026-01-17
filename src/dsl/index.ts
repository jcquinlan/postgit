/**
 * Postgit DSL - Write workflows as natural async TypeScript
 * 
 * These functions are analyzed at compile time and transformed into
 * the workflow AST. They never actually execute at runtime.
 */

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
}

export interface HitEndpointOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
}

/**
 * Make an HTTP request and store the response in the workflow blackboard.
 * 
 * @example
 * const response = await hitEndpoint("https://api.example.com/data");
 * // response.body.someField is now available
 * 
 * @example
 * const result = await hitEndpoint("https://api.example.com/submit", {
 *   method: "POST",
 *   body: { key: "value" }
 * });
 */
export declare function hitEndpoint(url: string, options?: HitEndpointOptions): Promise<HttpResponse>;

/**
 * Pause workflow execution for a specified duration.
 * This is a durable sleep - the workflow will resume even if the worker restarts.
 * 
 * @example
 * await sleep(30); // Wait 30 seconds
 */
export declare function sleep(seconds: number): Promise<void>;

/**
 * Send an email (or log it in MVP mode).
 * 
 * @example
 * await sendEmail({
 *   to: "user@example.com",
 *   subject: "Hello",
 *   body: "World"
 * });
 * 
 * @example
 * const data = await hitEndpoint("https://api.example.com");
 * await sendEmail({
 *   to: "user@example.com", 
 *   subject: "Results",
 *   body: data.body.message  // Reference data from previous step
 * });
 */
export declare function sendEmail(options: SendEmailOptions): Promise<void>;

/**
 * A persistent key-value store interface.
 * Values are stored durably in Postgres and persist across workflow runs.
 */
export interface KVStore {
  /**
   * Get a value from the store.
   * @returns The value, or undefined if not found
   */
  get(key: string): Promise<any>;
  
  /**
   * Set a value in the store.
   */
  set(key: string, value: any): Promise<void>;
}

/**
 * Create a reference to a persistent key-value store.
 * The store is shared across all workflow instances with the same name.
 * 
 * @example
 * const store = kv("my-store");
 * await store.set("counter", 1);
 * const value = await store.get("counter");
 * 
 * @example
 * const config = kv("app-config");
 * const apiKey = await config.get("apiKey");
 */
export declare function kv(storeName: string): KVStore;

/**
 * Intentionally fail N times before succeeding.
 * Useful for testing retry logic and workflow durability.
 * 
 * @param times - Number of times to fail before succeeding
 * 
 * @example
 * // Fails 3 times, succeeds on 4th attempt
 * await failFor(3);
 */
export declare function failFor(times: number): Promise<void>;
