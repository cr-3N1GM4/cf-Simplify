# CF Simplify privacy policy

CF Simplify shows Codeforces problems as short, formal statements. It collects nothing about you.

**What it reads.** It runs only on Codeforces problem pages and reads the problem shown there.

**What it sends, and to whom.**

- To the shared library (a static website, normally GitHub Pages): the contest number and problem letter of the problem you open, so it can download that problem's simplified statement.
- To the Codeforces API: the contest number, to check whether the contest has finished. The extension stays paused during running contests.
- Only if you add your own API key in Settings: the text of the problem statement you open, sent with your key to the AI provider you chose (for example Google Gemini or Groq). That provider's own terms apply; some free tiers use requests to improve their models. Problem statements are public text.

**What it stores.** Your settings and your API key are kept in your browser's extension storage. The key is never synced to other devices and is never sent anywhere except the provider you chose. Simplified statements are saved in your browser so they open instantly next time; you can delete them in Settings.

**What it never does.** No analytics, no tracking, no accounts, no ads, and no data is sold or shared.

**Permissions.** Access to codeforces.com (to show the statements), to the library website, and to the AI providers listed in Settings. If you enter a different library or AI address, the extension asks for permission to reach that one address.

Questions: open an issue in the project's GitHub repository.
