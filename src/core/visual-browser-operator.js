/**
 * VisualBrowserOperator - Enhanced browser automation with visual understanding.
 * This module extends basic browser control with vision-based element detection.
 */

export class VisualBrowserOperator {
  constructor({ browserPlaywright, visionProvider }) {
    this.browser = browserPlaywright;
    this.visionProvider = visionProvider;
    this.elementCache = new Map();
    this.lastScreenshot = null;
  }

  /**
   * Take a screenshot and analyze it for interactive elements.
   * @returns {Promise<Object>} Screenshot with detected elements.
   */
  async analyzeCurrentPage() {
    try {
      const screenshot = await this.browser.takeScreenshot();
      this.lastScreenshot = screenshot;

      if (!this.visionProvider) {
        return {
          screenshot,
          elements: [],
          analysis: "Vision provider not configured",
        };
      }

      const analysis = await this.visionProvider.analyzeImage(screenshot, {
        prompt: "Identify all interactive elements (buttons, links, input fields, etc.) visible on this page. For each element, provide its approximate position, type, and visible text.",
      });

      return {
        screenshot,
        elements: this.parseElementsFromAnalysis(analysis),
        analysis,
      };
    } catch (error) {
      console.warn("Failed to analyze page:", error.message);
      return {
        screenshot: null,
        elements: [],
        error: error.message,
      };
    }
  }

  /**
   * Click on an element identified by visual description.
   * @param {string} description - Visual description of the element (e.g., "blue button labeled Submit").
   * @returns {Promise<Object>} Result of the click action.
   */
  async clickByVisualDescription(description) {
    try {
      const analysis = await this.analyzeCurrentPage();
      const element = this.findElementByDescription(analysis.elements, description);

      if (!element) {
        return {
          success: false,
          error: `Could not find element matching: ${description}`,
        };
      }

      await this.browser.click(element.selector);

      return {
        success: true,
        element: element.label,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Type text into a field identified by visual description.
   * @param {string} description - Visual description of the input field.
   * @param {string} text - Text to type.
   * @returns {Promise<Object>} Result of the type action.
   */
  async typeByVisualDescription(description, text) {
    try {
      const analysis = await this.analyzeCurrentPage();
      const element = this.findElementByDescription(analysis.elements, description);

      if (!element) {
        return {
          success: false,
          error: `Could not find input field matching: ${description}`,
        };
      }

      await this.browser.type(element.selector, text);

      return {
        success: true,
        element: element.label,
        textEntered: text,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Extract text content from a specific area of the page.
   * @param {string} description - Visual description of the area.
   * @returns {Promise<string>} Extracted text content.
   */
  async extractTextByVisualDescription(description) {
    try {
      const analysis = await this.analyzeCurrentPage();
      const element = this.findElementByDescription(analysis.elements, description);

      if (!element) {
        return `Could not find element matching: ${description}`;
      }

      const text = await this.browser.getText(element.selector);
      return text;
    } catch (error) {
      return `Error extracting text: ${error.message}`;
    }
  }

  /**
   * Find an element by visual description.
   * @param {Array<Object>} elements - Detected elements.
   * @param {string} description - Visual description.
   * @returns {Object|null} Matching element or null.
   */
  findElementByDescription(elements, description) {
    const descLower = description.toLowerCase();

    for (const element of elements) {
      const label = (element.label || "").toLowerCase();
      const type = (element.type || "").toLowerCase();
      const text = (element.text || "").toLowerCase();

      if (label.includes(descLower) || text.includes(descLower) || type.includes(descLower)) {
        return element;
      }
    }

    return null;
  }

  /**
   * Parse elements from vision provider analysis.
   * @param {string} analysis - Analysis text from vision provider.
   * @returns {Array<Object>} Parsed elements.
   */
  parseElementsFromAnalysis(analysis) {
    const elements = [];

    const lines = String(analysis || "").split("\n");
    for (const line of lines) {
      if (line.includes("button") || line.includes("link") || line.includes("input")) {
        elements.push({
          type: this.extractElementType(line),
          label: this.extractElementLabel(line),
          text: this.extractElementText(line),
          selector: null,
        });
      }
    }

    return elements;
  }

  extractElementType(line) {
    if (line.includes("button")) return "button";
    if (line.includes("link")) return "link";
    if (line.includes("input")) return "input";
    if (line.includes("field")) return "field";
    return "element";
  }

  extractElementLabel(line) {
    const match = line.match(/(?:labeled|named|titled|with text)[\s:"']*([^,.\n]+)/i);
    return match ? match[1].trim() : "";
  }

  extractElementText(line) {
    const match = line.match(/["']([^"']+)["']/);
    return match ? match[1] : "";
  }

  /**
   * Get current page context for the agent.
   * @returns {Promise<Object>} Page context.
   */
  async getPageContext() {
    try {
      const analysis = await this.analyzeCurrentPage();
      return {
        url: await this.browser.getCurrentUrl?.(),
        title: await this.browser.getPageTitle?.(),
        screenshot: analysis.screenshot,
        elements: analysis.elements,
        analysis: analysis.analysis,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}
