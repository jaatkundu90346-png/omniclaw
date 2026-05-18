/**
 * MultiProviderFallback - Intelligent provider selection and fallback strategy.
 * This module manages multiple LLM providers with automatic failover.
 */

export class MultiProviderFallback {
  constructor({ providers = [], configStore }) {
    this.providers = providers;
    this.configStore = configStore;
    this.healthChecks = new Map();
    this.fallbackChain = [];
    this.buildFallbackChain();
  }

  /**
   * Build the fallback chain from configuration.
   */
  buildFallbackChain() {
    const config = this.configStore.getConfig();
    const profiles = config.providerProfiles || {};

    this.fallbackChain = [
      { id: "primary", profile: config.provider },
      ...Object.entries(profiles)
        .filter(([, profile]) => profile.enabled !== false)
        .map(([id, profile]) => ({ id, profile }))
        .slice(0, 2),
    ];
  }

  /**
   * Perform a health check on a provider.
   * @param {Object} provider - Provider configuration.
   * @returns {Promise<Object>} Health check result.
   */
  async checkProviderHealth(provider) {
    const cacheKey = JSON.stringify(provider);
    const cached = this.healthChecks.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.result;
    }

    const result = {
      healthy: false,
      latency: 0,
      error: null,
      timestamp: Date.now(),
    };

    try {
      const start = Date.now();
      const response = await fetch(provider.baseUrl + "/health", {
        timeout: 5000,
        headers: { Authorization: `Bearer ${provider.apiKey}` },
      });
      result.latency = Date.now() - start;
      result.healthy = response.ok;
    } catch (error) {
      result.error = error.message;
      result.healthy = false;
    }

    this.healthChecks.set(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  /**
   * Get the best available provider based on health and configuration.
   * @returns {Promise<Object>} The selected provider configuration.
   */
  async selectProvider() {
    for (const { id, profile } of this.fallbackChain) {
      const health = await this.checkProviderHealth(profile);
      if (health.healthy) {
        return { id, profile, health };
      }
    }

    return {
      id: "fallback",
      profile: this.fallbackChain[0].profile,
      health: { healthy: false, error: "No healthy providers available" },
    };
  }

  /**
   * Execute a request with automatic fallback.
   * @param {Function} requestFn - Function that takes a provider and returns a promise.
   * @param {Object} options - Execution options.
   * @returns {Promise<Object>} Request result.
   */
  async executeWithFallback(requestFn, options = {}) {
    const maxRetries = options.maxRetries || this.fallbackChain.length;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const selected = await this.selectProvider();

      try {
        const result = await requestFn(selected.profile);
        return {
          success: true,
          result,
          providerId: selected.id,
          attempt,
        };
      } catch (error) {
        lastError = error;
        console.warn(`Provider ${selected.id} failed (attempt ${attempt + 1}):`, error.message);

        if (attempt < maxRetries - 1) {
          await this.delay(Math.pow(2, attempt) * 1000);
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || "All providers failed",
      attempt: maxRetries,
    };
  }

  /**
   * Delay execution for a specified duration.
   * @param {number} ms - Milliseconds to delay.
   * @returns {Promise<void>}
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get provider status summary.
   * @returns {Promise<Object>} Status of all providers.
   */
  async getProviderStatus() {
    const status = {
      timestamp: new Date().toISOString(),
      providers: [],
    };

    for (const { id, profile } of this.fallbackChain) {
      const health = await this.checkProviderHealth(profile);
      status.providers.push({
        id,
        name: profile.name || id,
        healthy: health.healthy,
        latency: health.latency,
        error: health.error,
      });
    }

    return status;
  }

  /**
   * Add a new provider to the fallback chain.
   * @param {string} id - Provider ID.
   * @param {Object} profile - Provider configuration.
   */
  addProvider(id, profile) {
    this.fallbackChain.push({ id, profile });
  }

  /**
   * Remove a provider from the fallback chain.
   * @param {string} id - Provider ID.
   */
  removeProvider(id) {
    this.fallbackChain = this.fallbackChain.filter((p) => p.id !== id);
  }

  /**
   * Clear health check cache.
   */
  clearHealthCache() {
    this.healthChecks.clear();
  }
}
