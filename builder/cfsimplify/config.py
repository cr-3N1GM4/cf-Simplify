"""Settings for the library builder, read from the .env file in the project root."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXTENSION_DIR = ROOT / "extension"
PROMPT_PATH = EXTENSION_DIR / "prompt.txt"
HINT_TERMS_PATH = EXTENSION_DIR / "shared" / "hint-terms.json"
EXTENSION_CONFIG_PATH = EXTENSION_DIR / "config.json"
STATE_DIR = ROOT / "builder" / "state"
DEFAULT_LIBRARY_DIR = ROOT / "library"

# Keep the defaults in sync with extension/shared/providers.js.
PROVIDERS = {
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_env": "GEMINI_API_KEY",
        "default_model": "gemini-flash-latest",
        "rpm": 8,
        "key_url": "https://aistudio.google.com/apikey",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "key_env": "GROQ_API_KEY",
        "default_model": "openai/gpt-oss-120b",
        "rpm": 20,
        "key_url": "https://console.groq.com/keys",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "key_env": "OPENROUTER_API_KEY",
        "default_model": "",
        "rpm": 15,
        "key_url": "https://openrouter.ai/keys",
    },
    "ollama": {
        "base_url": "http://localhost:11434/v1",
        "base_url_env": "OLLAMA_BASE_URL",
        "key_env": None,
        "default_model": "gemma3:12b",
        "rpm": 0,
        "key_url": "https://ollama.com/download",
    },
    "custom": {
        "base_url": "",
        "base_url_env": "CUSTOM_BASE_URL",
        "key_env": "CUSTOM_API_KEY",
        "default_model": "",
        "rpm": 0,
        "key_url": "",
    },
}


class SettingsError(Exception):
    """A problem with the .env settings, explained for a human."""


@dataclass
class ProviderSettings:
    name: str
    base_url: str
    api_key: str
    model: str
    rpm: int
    daily_limit: int


@dataclass
class Settings:
    providers: list[ProviderSettings] = field(default_factory=list)
    llm_timeout: float = 180.0
    cf_base_url: str = "https://codeforces.com"
    cf_delay: float = 2.5
    cf_cookie: str = ""
    cf_user_agent: str = ""
    cf_fetch_mode: str = "auto"
    cf_browser_headless: bool = False
    library_dir: Path = DEFAULT_LIBRARY_DIR
    library_public_url: str = ""
    github_repo: str = ""
    state_dir: Path = STATE_DIR


def load_env_file() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    try:
        from dotenv import load_dotenv
    except ImportError:  # tiny fallback parser
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.split(" #")[0].strip().strip('"').strip("'")
            os.environ.setdefault(key.strip(), value)
        return
    load_dotenv(env_path, override=False)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _int(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise SettingsError(f"{name} in .env must be a whole number (it is {raw!r}).") from exc


def _float(name: str, default: float) -> float:
    raw = _env(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise SettingsError(f"{name} in .env must be a number (it is {raw!r}).") from exc


def _provider(name: str) -> ProviderSettings:
    preset = PROVIDERS.get(name)
    if preset is None:
        raise SettingsError(
            f"Unknown provider {name!r}. Use one of: {', '.join(PROVIDERS)} (LLM_PROVIDER / LLM_FALLBACK in .env)."
        )
    upper = name.upper()
    base_url = preset["base_url"]
    if preset.get("base_url_env"):
        base_url = _env(preset["base_url_env"], base_url) or base_url
    base_url = base_url.rstrip("/")
    api_key = _env(preset["key_env"]) if preset["key_env"] else ""
    model = _env(f"{upper}_MODEL") or preset["default_model"]

    if not base_url:
        raise SettingsError(f"Set {preset.get('base_url_env', upper + '_BASE_URL')} in .env for the {name} provider.")
    if preset["key_env"] and name != "custom" and not api_key:
        hint = f" Get one at {preset['key_url']}" if preset["key_url"] else ""
        raise SettingsError(
            f"{preset['key_env']} is empty in .env (on GitHub: add it under Settings > Secrets and variables > Actions).{hint}"
        )
    if not model:
        raise SettingsError(f"Set {upper}_MODEL in .env (the {name} provider has no default model).")
    return ProviderSettings(
        name=name,
        base_url=base_url,
        api_key=api_key,
        model=model,
        rpm=_int(f"{upper}_RPM", preset["rpm"]),
        daily_limit=_int(f"{upper}_DAILY_LIMIT", 0),
    )


def library_url_from_repo(repo: str) -> str:
    """owner/name -> https://owner.github.io/name (the GitHub Pages address)."""
    if "/" not in repo:
        return ""
    owner, name = repo.split("/", 1)
    owner, name = owner.strip(), name.strip().removesuffix(".git")
    if not owner or not name:
        return ""
    if name.lower() == f"{owner.lower()}.github.io":
        return f"https://{owner.lower()}.github.io"
    return f"https://{owner.lower()}.github.io/{name}"


def load_settings(require_llm: bool = True) -> Settings:
    load_env_file()
    settings = Settings()
    if require_llm:
        chain = [_env("LLM_PROVIDER", "gemini").lower() or "gemini"]
        for extra in _env("LLM_FALLBACK").split(","):
            extra = extra.strip().lower()
            if extra and extra not in chain:
                chain.append(extra)
        settings.providers = [_provider(name) for name in chain]
    settings.llm_timeout = _float("LLM_TIMEOUT_SECONDS", 180.0)
    settings.cf_base_url = (_env("CF_BASE_URL") or "https://codeforces.com").rstrip("/")
    settings.cf_delay = _float("CF_REQUEST_DELAY_SECONDS", 2.5)
    settings.cf_cookie = _env("CF_COOKIE")
    settings.cf_user_agent = _env("CF_USER_AGENT")
    mode = (_env("CF_FETCH_MODE") or "auto").lower()
    if mode not in ("auto", "requests", "browser"):
        raise SettingsError("CF_FETCH_MODE in .env must be auto, requests or browser.")
    settings.cf_fetch_mode = mode
    settings.cf_browser_headless = _env("CF_BROWSER_HEADLESS").lower() in ("1", "true", "yes")
    library_dir = _env("LIBRARY_DIR")
    settings.library_dir = (ROOT / library_dir).resolve() if library_dir else DEFAULT_LIBRARY_DIR
    settings.github_repo = _env("GITHUB_REPO").removeprefix("https://github.com/").strip("/")
    settings.library_public_url = (_env("LIBRARY_PUBLIC_URL") or library_url_from_repo(settings.github_repo)).rstrip("/")
    state_dir = _env("BUILDER_STATE_DIR")
    settings.state_dir = Path(state_dir).resolve() if state_dir else STATE_DIR
    return settings


def extension_config() -> dict:
    try:
        return json.loads(EXTENSION_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def prompt_version() -> int:
    try:
        return int(extension_config().get("promptVersion", 1))
    except (TypeError, ValueError):
        return 1
