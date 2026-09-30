cf-simplify (Codeforces Simplify)

cf-simplify is a comprehensive toolset and browser extension designed to simplify, enhance, and manage Codeforces competitive programming problems. By leveraging a Python-based pipeline with LLM integration, it processes problem statements and serves them cleanly through a cross-browser extension equipped with MathJax rendering and hint-term definitions.

Features

Browser Extension: Available for Chromium-based browsers and Firefox to seamlessly integrate into your Codeforces workflow.

LLM-Powered Simplification: Uses an automated Python builder to extract and simplify complex problem statements using Large Language Models.

MathJax Support: Ensures all complex mathematical equations in problem statements are rendered flawlessly via a dedicated MathJax bridge.

Pre-built Problem Library: Caches simplified problems (e.g., Problem 1A, 4A) in a structured JSON library for fast access.

Hint Terms: Built-in dictionaries to explain common competitive programming terminology directly in the browser.

Installation Guide for Browsers

You can manually install the cf-simplify extension on any major browser using the files located in the cf-simplify/extension/ directory.

Google Chrome, Microsoft Edge, and Brave

Download or clone this repository to your local machine.

Open your browser and navigate to the extensions management page:

Chrome: chrome://extensions/

Edge: edge://extensions/

Brave: brave://extensions/

Enable Developer mode (usually a toggle in the top right corner).

Click the Load unpacked button.

Select the cf-simplify/extension/ folder from the cloned repository.

The extension is now installed and can be configured by clicking its icon to access the options page.

Mozilla Firefox

Download or clone this repository to your local machine.

Open Firefox and navigate to about:debugging#/runtime/this-firefox.

Click the Load Temporary Add-on... button.

Navigate to the cloned repository, open the cf-simplify/extension/ folder, and select the manifest.json file.

The extension will remain active until you restart Firefox.

Project Architecture & Directory Structure

The project is divided into three main ecosystems: the browser extension, the Python builder pipeline, and the problem library.

1. The Browser Extension (cf-simplify/extension/)

This is the user-facing frontend that interacts with the Codeforces website.

manifest.json: The core configuration file required by browsers to load the extension.

background.js: Runs in the background to handle extension events and state management.

content/: Scripts injected directly into Codeforces pages. content.js and content.css modify the page structure, while render.js and mathjax-bridge.js handle the rendering of simplified text and mathematical formulas.

shared/: Contains core logic shared across the extension, including checks.js, providers.js, and hint-terms.json (which provides definitions for specific competitive programming terms).

options/: Contains the HTML, CSS, and JS files for the extension's user settings menu.

icons/: UI assets in various sizes (16px, 32px, 48px, 128px).

2. The Python Builder (cf-simplify/builder/)

This backend pipeline automates the fetching and processing of Codeforces problems.

requirements.txt: Lists the Python dependencies required to run the builder.

build.py: The main execution script to trigger the pipeline.

cfsimplify/ module:

codeforces.py: Handles API interactions and web scraping specific to Codeforces.

extract.py: Parses the raw HTML and text from the fetched problems.

llm.py: Interfaces with Large Language Models to rewrite and simplify the extracted problem statements.

pipeline.py & state.py: Manages the workflow and state of the generation process.

checks.py & library.py: Validates the output and formats it for storage.

3. The Library (cf-simplify/library/)

A structured database of pre-processed problems consumed by the extension.

index.json: The master index mapping problem IDs to their simplified files.

problems/: Contains the simplified output files categorized by contest and problem ID (e.g., 1/A.json, 4/A.json).

4. Tests & CI/CD

cf-simplify/tests/: Contains comprehensive test suites. The js/ folder includes tests for the extension's rendering, options, and background scripts, while the python/ folder contains end-to-end (test_e2e.py) and core pipeline tests (test_core.py). It also includes HTML fixtures of modern and old Codeforces problems to ensure the extraction works perfectly.

.github/workflows/: Contains GitHub Actions (publish-library.yml and update-library.yml) to automatically process new Codeforces problems and publish the updated library database.