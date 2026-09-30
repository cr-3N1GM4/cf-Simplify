# **cf-simplify (Codeforces Simplify)**

**cf-simplify** is an LLM-powered browser extension and Python pipeline that simplifies complex Codeforces problem statements, helping you focus on solving the logic rather than decoding the question[cite: 1].

## **Key Features**
* **Browser Extension Integration:** Native support for Chromium-based browsers (Chrome, Edge, Brave) and Firefox[cite: 1].
* **LLM-Powered Simplification:** A dedicated Python builder pipeline that extracts, processes, and rewrites verbose problem statements using Large Language Models[cite: 1].
* **Seamless MathJax Rendering:** Contains a dedicated bridge to ensure complex mathematical equations render perfectly within the injected extension interface[cite: 1].
* **Pre-built Problem Library:** Caches simplified problems (e.g., Problem 1A, 4A) in a structured JSON database for instantaneous access without real-time generation delays[cite: 1].
* **Inline Hint Terms:** Built-in dictionaries that provide immediate definitions for common competitive programming terminology directly on the page[cite: 1].

## **Installation Guide**
You can manually install the extension directly from the `cf-simplify/extension/` directory[cite: 1].

### **Chrome, Edge, and Brave**
1. Clone or download this repository to your local computer.
2. Open your browser and navigate to the extensions management page (e.g., `chrome://extensions/` or `edge://extensions/`).
3. Toggle **Developer mode** on (typically located in the top right corner).
4. Click **Load unpacked** and select the `cf-simplify/extension/` folder[cite: 1].
5. The extension is now active. Click the extension icon to access the options panel and customize your settings[cite: 1].

### **Mozilla Firefox**
1. Clone or download this repository.
2. Navigate to `about:debugging#/runtime/this-firefox` in your Firefox address bar.
3. Click the **Load Temporary Add-on...** button.
4. Select the `manifest.json` file located inside the `cf-simplify/extension/` folder[cite: 1].

## **Project Architecture**
This repository is divided into three primary components[cite: 1]:

### **1. The Browser Extension (`cf-simplify/extension/`)**
The frontend user interface that interacts directly with the Codeforces website[cite: 1].
* **`manifest.json` & `background.js`:** Core browser configurations and background state management[cite: 1].
* **`content/`:** Scripts (`content.js`, `content.css`) and rendering tools (`render.js`, `mathjax-bridge.js`) injected into Codeforces problem pages[cite: 1].
* **`shared/`:** Shared logic (`checks.js`, `providers.js`) and terminology dictionaries (`hint-terms.json`)[cite: 1].
* **`options/`:** Settings menu interface files (`options.html`, `options.css`, `options.js`)[cite: 1].
* **`icons/`:** UI assets provided in various resolutions (16px, 32px, 48px, 128px)[cite: 1].

### **2. The Python Builder (`cf-simplify/builder/`)**
The backend pipeline that automates problem extraction and LLM interaction[cite: 1].
* **`build.py` & `requirements.txt`:** The main execution script and its required Python dependencies[cite: 1].
* **`cfsimplify/` Module:** Modular Python scripts (`codeforces.py`, `extract.py`, `llm.py`, `pipeline.py`, `library.py`) that handle Codeforces HTML scraping, text extraction, API prompting, validation, and saving[cite: 1].

### **3. The Problem Library (`cf-simplify/library/`)**
A cached JSON database of processed problem statements[cite: 1].
* **`index.json`:** The master mapping file for all simplified problems[cite: 1].
* **`problems/`:** Directory storing the final simplified JSON outputs categorized by contest ID (e.g., `1/A.json`, `4/A.json`)[cite: 1].

## **Testing and Automation**
* **Comprehensive Tests (`cf-simplify/tests/`):** Features exhaustive test suites. The `js/` directory includes Mocha/Jest-style tests for extension components (`background.test.mjs`, `render.test.mjs`), while the `python/` directory contains core logic and end-to-end tests (`test_core.py`, `test_e2e.py`) using provided HTML fixtures[cite: 1].
* **GitHub Actions (`.github/workflows/`):** Automated CI/CD workflows (`update-library.yml`, `publish-library.yml`) designed to periodically fetch new Codeforces problems, process them, and update the repository library automatically[cite: 1].
