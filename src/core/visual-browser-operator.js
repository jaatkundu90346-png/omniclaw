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
      const screenshot = await this.browser.screenshot({ fullPage: false });
      this.lastScreenshot = screenshot;

      const domElements = await this.extractDomElements();

      if (!this.visionProvider) {
        return {
          screenshot,
          elements: domElements,
          analysis: "Vision provider not configured; using DOM-derived interactive elements.",
        };
      }

      const analysis = await this.visionProvider.analyzeImage(screenshot, {
        prompt: "Identify all interactive elements (buttons, links, input fields, etc.) visible on this page. For each element, provide its approximate position, type, and visible text.",
      });

      return {
        screenshot,
        elements: [...domElements, ...this.parseElementsFromAnalysis(analysis)],
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

      if (!element.selector) {
        return {
          success: false,
          error: `Matched element has no selector: ${description}`,
          element,
        };
      }

      await this.browser.click({ selector: element.selector });

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

      if (!element.selector) {
        return {
          success: false,
          error: `Matched input has no selector: ${description}`,
          element,
        };
      }

      await this.browser.type({ selector: element.selector, text });

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

      const result = await this.browser.evaluate({
        script: (selector) => document.querySelector(selector)?.innerText || document.querySelector(selector)?.textContent || "",
        args: [element.selector],
      });
      return result?.result || "";
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

  async extractDomElements() {
    const result = await this.browser.evaluate({
      script: () => {
        const selectorFor = (element) => {
          if (element.id) return `#${CSS.escape(element.id)}`;
          const attr = ["aria-label", "name", "placeholder", "title"].find((key) => element.getAttribute(key));
          if (attr) {
            return `${element.tagName.toLowerCase()}[${attr}="${CSS.escape(element.getAttribute(attr))}"]`;
          }
          const text = (element.innerText || element.textContent || "").trim();
          if (text && text.length < 60) {
            return `${element.tagName.toLowerCase()}:has-text("${text.replace(/"/g, '\\"')}")`;
          }
          return element.tagName.toLowerCase();
        };
        return Array.from(document.querySelectorAll("button,a,input,textarea,select,[role='button'],[contenteditable='true']"))
          .slice(0, 80)
          .map((element) => ({
            type: element.tagName.toLowerCase(),
            label: element.getAttribute("aria-label") || element.getAttribute("name") || element.getAttribute("placeholder") || "",
            text: (element.innerText || element.value || element.textContent || "").trim().slice(0, 120),
            selector: selectorFor(element),
          }));
      },
    });
    return Array.isArray(result?.result) ? result.result : [];
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
