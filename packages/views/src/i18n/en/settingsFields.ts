import { DEFAULT_LLM_BASE_URL } from "@mdcz/shared/llm";
import type { FieldAnchor, FieldKey } from "@mdcz/shared/settingsRegistry";

export interface FieldText {
  label: string;
  description?: string;
  /** Extra search terms; settings search matches the text of every locale. */
  aliases?: string[];
}

export interface SectionText {
  label: string;
  aliases?: string[];
}

const PRIORITY_ALIASES = ["aggregation", "priority"];

const sections: Record<FieldAnchor, SectionText> = {
  paths: { label: "Paths", aliases: ["path", "paths", "folder", "directory", "directories", "exclude", "actor photo"] },
  scrape: { label: "Scraping", aliases: ["scrape", "crawler", "rate", "limit"] },
  sites: { label: "Sites", aliases: ["site", "sites", "source", "sources", "cookie", "mirror"] },
  network: { label: "Network", aliases: ["network", "proxy", "retry", "timeout"] },
  translate: { label: "Translation", aliases: ["translate", "translation", "translator", "llm", "language"] },
  naming: { label: "Naming", aliases: ["naming", "name", "template", "rule", "rules"] },
  download: { label: "Downloads", aliases: ["download", "asset", "poster", "fanart", "nfo"] },
  mediaServer: { label: "Media servers", aliases: ["media server", "jellyfin", "emby", "person", "actor"] },
  automation: {
    label: "Integrations",
    aliases: [
      "integration",
      "automation",
      "downloader",
      "qbittorrent",
      "clouddrive",
      "api key",
      "webhook",
      "telegram",
      "bark",
      "ntfy",
      "notification",
    ],
  },
};

const fields: Record<FieldKey, FieldText> = {
  "translate.deeplApiKey": {
    label: "DeepL API key",
    description: "Free keys ending in :fx use the Free API; other keys use the Pro API.",
  },
  "translate.baiduService": {
    label: "Baidu translation service",
    description:
      "Enable the service on the Baidu Translate Open Platform first. General text translation uses the secret key; LLM text translation uses an API key.",
  },
  "translate.baiduAppId": {
    label: "Baidu translation APPID",
    description: "Shown on the Developer Information page of the Baidu Translate Open Platform.",
  },
  "translate.baiduSecretKey": {
    label: "Baidu translation secret key",
    description: "Shown on the Developer Information page.",
  },
  "translate.baiduApiKey": {
    label: "Baidu translation API key",
    description: "Create it under API Key Management in the console.",
  },
  "paths.defaultScanExcludeDirs": {
    label: "Excluded directories",
    description: "These folders are skipped automatically when scanning the library.",
    aliases: ["scan exclude", "exclude dirs"],
  },
  "paths.actorPhotoFolder": {
    label: "Local actor photo directory",
    description:
      "Only read when “Local” is enabled in the person photo source order; used for local photo overrides and media server photo sync.",
    aliases: ["actor", "photo"],
  },
  "paths.sceneImagesFolder": { label: "Scene image folder name" },
  "paths.configDirectory": { label: "Configuration directory", aliases: ["config", "profile"] },
  "scrape.sites": {
    label: "Site order",
    description:
      "Check a site to scrape it. Move rows to set priority. Unchecked sites keep their position and are skipped.",
    aliases: [
      "site priority",
      "order",
      "DMM",
      "FANZA",
      "DMM TV",
      "MGStage",
      "Prestige",
      "Faleno",
      "Dahlia",
      "KM Produce",
      "Sokmil",
      "Kingdom",
      "JavDB",
      "JavBus",
      "Jav321",
      "AVBase",
      "FC2",
      "FC2Hub",
      "H0930",
      "H4610",
      "PPVDataBank",
      "R18.dev",
      "AVWikiDB",
    ],
  },
  "scrape.siteOrder": { label: "Site position" },
  "scrape.r18MetadataLanguage": { label: "R18.dev metadata language" },
  "scrape.aiNumberFallback": {
    label: "AI movie code fallback",
    description:
      "Try AI when no code is detected, or no movie is found despite at least one site responding normally. Reuses the translation LLM settings without enabling translation. Sends the file name and immediate parent folder name; unresolved files remain for manual repair.",
    aliases: ["AI", "LLM", "code", "fallback"],
  },
  "scrape.filenameIgnoreTokens": {
    label: "Code detection ignore words",
    description:
      "Ignored before detecting the movie code; only affects detection and never renames files. Add with Enter, comma or space.",
  },
  "scrape.filenameBlacklistTokens": {
    label: "Auto-scan blacklist words",
    description:
      "Files and folders (with everything inside) whose names contain these words are excluded from automatic scans; matching is case-insensitive. Add with Enter, comma or space.",
  },
  "scrape.minVideoSizeMb": {
    label: "Minimum video size (MB)",
    description:
      "Videos smaller than this size are excluded from scraping candidates. 0 means no limit; STRM files are unaffected.",
  },
  "scrape.subtitleKeywords": {
    label: "Subtitle keywords",
    description:
      "Detect Chinese subtitles using multiple case-insensitive keywords in file names and full paths. Short Latin flags require separators. Add with Enter or comma; clear to disable keyword detection.",
  },
  "scrape.umrKeywords": {
    label: "Decensored keywords",
    description:
      "Detect decensored versions using multiple case-insensitive keywords in file names and full paths. Short Latin flags require separators. Decensored takes priority over leaked and uncensored.",
  },
  "scrape.uncensoredKeywords": {
    label: "Uncensored keywords",
    description:
      "Detect uncensored versions using multiple case-insensitive keywords in file names and full paths. Short Latin flags require separators. Studio detection by catalog code still applies.",
  },
  "scrape.leakKeywords": {
    label: "Leaked keywords",
    description:
      "Detect leaked versions using multiple case-insensitive keywords in file names and full paths. Short Latin flags require separators. Leaked takes priority over uncensored, after decensored.",
  },
  "scrape.threadNumber": { label: "Concurrent threads" },
  "scrape.javdbDelaySeconds": { label: "JavDB request delay (s)" },
  "scrape.restAfterCount": { label: "Pause after consecutive scrapes (items)" },
  "scrape.restDuration": { label: "Pause duration" },
  "network.proxyType": { label: "Proxy type" },
  "network.proxy": { label: "Proxy address" },
  "network.useProxy": { label: "Use proxy" },
  "network.directSites": { label: "Direct sites (bypass proxy)" },
  "network.timeout": { label: "Timeout (s)" },
  "network.retryCount": { label: "Retry count" },
  "network.javdbUrl": {
    label: "JavDB URL",
    description: "Leave empty to use https://javdb.com. Enter a mirror address if the official site is blocked.",
    aliases: ["mirror", "domain", "javdb", "url"],
  },
  "network.javbusUrl": {
    label: "JavBus URL",
    description: "Leave empty to use https://www.javbus.com. Enter a mirror address if the official site is blocked.",
    aliases: ["mirror", "domain", "javbus", "url"],
  },
  "network.javdbCookie": { label: "JavDB Cookie", aliases: ["cookie", "javdb", "credentials"] },
  "network.javbusCookie": { label: "JavBus Cookie", aliases: ["cookie", "javbus", "credentials"] },
  "network.fantiaCookie": { label: "Fantia Cookie", aliases: ["cookie", "fantia", "credentials"] },
  "aggregation.fieldPriorities.title": {
    label: "Title source order",
    description: "Pick the movie title by site order.",
    aliases: [...PRIORITY_ALIASES, "title", "field source"],
  },
  "aggregation.fieldPriorities.plot": {
    label: "Plot source order",
    description: "Pick the movie plot by site order.",
    aliases: [...PRIORITY_ALIASES, "plot", "summary"],
  },
  "aggregation.fieldPriorities.actors": {
    label: "Actor source order",
    description: "Pick the actor list by site order.",
    aliases: [...PRIORITY_ALIASES, "actors", "cast"],
  },
  "aggregation.fieldPriorities.genres": {
    label: "Genre source order",
    description: "Pick genres and tags by site order.",
    aliases: [...PRIORITY_ALIASES, "genres", "tags"],
  },
  "aggregation.fieldPriorities.thumb_url": {
    label: "Thumbnail source order",
    description: "Pick the landscape thumbnail by site order.",
    aliases: [...PRIORITY_ALIASES, "thumb", "thumbnail"],
  },
  "aggregation.fieldPriorities.poster_url": {
    label: "Poster source order",
    description: "Pick the poster by site order.",
    aliases: [...PRIORITY_ALIASES, "poster", "cover"],
  },
  "aggregation.fieldPriorities.scene_images": {
    label: "Scene image source order",
    description: "Pick the scene image set by site order.",
    aliases: [...PRIORITY_ALIASES, "scene images", "extrafanart"],
  },
  "aggregation.fieldPriorities.studio": {
    label: "Studio source order",
    description: "Pick studio information by site order.",
    aliases: [...PRIORITY_ALIASES, "studio", "maker"],
  },
  "aggregation.fieldPriorities.director": {
    label: "Director source order",
    description: "Pick director information by site order.",
    aliases: [...PRIORITY_ALIASES, "director"],
  },
  "aggregation.fieldPriorities.publisher": {
    label: "Publisher source order",
    description: "Pick publisher information by site order.",
    aliases: [...PRIORITY_ALIASES, "publisher", "label"],
  },
  "aggregation.fieldPriorities.series": {
    label: "Series source order",
    description: "Pick series information by site order.",
    aliases: [...PRIORITY_ALIASES, "series"],
  },
  "aggregation.fieldPriorities.release_date": {
    label: "Release date source order",
    description: "Pick the release date by site order.",
    aliases: [...PRIORITY_ALIASES, "release date", "date"],
  },
  "aggregation.fieldPriorities.durationSeconds": {
    label: "Duration source order",
    description: "Pick the movie duration by site order.",
    aliases: [...PRIORITY_ALIASES, "duration", "runtime"],
  },
  "aggregation.fieldPriorities.rating": {
    label: "Rating source order",
    description: "Pick the rating by site order.",
    aliases: [...PRIORITY_ALIASES, "rating", "score"],
  },
  "aggregation.fieldPriorities.trailer_url": {
    label: "Trailer source order",
    description: "Pick the trailer URL by site order.",
    aliases: [...PRIORITY_ALIASES, "trailer", "preview"],
  },
  "aggregation.maxParallelCrawlers": {
    label: "Parallel sites per aggregation",
    description: "Maximum number of sites queried at the same time when aggregating one movie.",
    aliases: ["aggregation", "parallel crawler"],
  },
  "aggregation.perCrawlerTimeoutMs": {
    label: "Per-site timeout (ms)",
    description: "Longest wait allowed for a single site during aggregation.",
    aliases: ["aggregation", "timeout", "single crawler timeout"],
  },
  "aggregation.globalTimeoutMs": {
    label: "Global timeout (ms)",
    description: "Total time allowed to aggregate one movie; must be greater than the per-site timeout.",
    aliases: ["aggregation", "timeout", "global timeout"],
  },
  "download.tagBadgeTargets": {
    label: "Target image types",
    description: "Only newly downloaded or generated images are processed.",
  },
  "download.tagBadgeStyle": { label: "Watermark style" },
  "download.tagBadgeResolutionStyle": {
    label: "Resolution watermark style",
    description: "Used for 1080P, 4K and 8K. MDCx uses the ribbon for 1080P.",
  },
  "download.tagBadgeLayout": {
    label: "Layout",
    description: "Horizontal: arrange at the starting corner. Clockwise/counterclockwise: distribute across corners.",
  },
  "download.tagBadgeScale": {
    label: "Scale divisor",
    description: "Watermark height = image height / divisor. Crowded layouts shrink to fit.",
  },
  "download.tagBadgeOffsetX": {
    label: "Horizontal margin (px)",
    description: "Minimum distance from the left and right edges.",
  },
  "download.tagBadgeOffsetY": {
    label: "Vertical margin (px)",
    description: "Minimum distance from the top and bottom edges.",
  },
  "download.tagBadgeGap": { label: "Watermark gap (px)" },
  "download.tagBadgeDirectory": {
    label: "Custom watermark directory",
    description: "Leave empty for the data directory’s watermark folder. On Web, enter a server directory.",
  },
  "download.tagBadgePositions.subtitle": { label: "Subtitle position" },
  "download.tagBadgePositions.censored": { label: "Censored position" },
  "download.tagBadgePositions.umr": { label: "Cracked position" },
  "download.tagBadgePositions.leak": { label: "Leaked position" },
  "download.tagBadgePositions.uncensored": { label: "Uncensored position" },
  "download.tagBadgePositions.fullHd": { label: "1080P position" },
  "download.tagBadgePositions.fourK": { label: "4K position" },
  "download.tagBadgePositions.eightK": { label: "8K position" },
  "download.downloadThumb": { label: "Download landscape thumbnail" },
  "download.downloadPoster": { label: "Download poster" },
  "download.tagBadges": {
    label: "Enable image watermarks",
    description: "Add watermarks based on movie information to selected image types.",
    aliases: ["badge", "badges", "mark", "corner"],
  },
  "download.tagBadgeTypes": {
    label: "Badge types",
    description:
      "Built-in badge types allowed to render. Unselected types are never drawn on images, even when detected.",
    aliases: [
      "badge types",
      "badge filters",
      "subtitle",
      "censored",
      "umr",
      "leak",
      "uncensored",
      "fullhd",
      "1080p",
      "2160p",
      "4k",
      "8k",
    ],
  },
  "download.tagBadgePosition": {
    label: "Badge position",
    description: "Multiple badges are stacked in order in the same corner.",
    aliases: ["badge position", "corner", "top left", "top right", "bottom left", "bottom right"],
  },
  "download.tagBadgeImageOverrides": {
    label: "Custom badge images",
    description:
      "When on, matching images from the watermark folder in the user data directory replace built-in badges.",
    aliases: ["watermark", "badge image", "custom badge", "poster badge image"],
  },
  "download.downloadFanart": { label: "Download fanart" },
  "download.downloadSceneImages": { label: "Download scene images" },
  "download.downloadTrailer": { label: "Download trailer" },
  "download.sceneImageConcurrency": {
    label: "Scene image download concurrency",
    description: "Only affects concurrent scene image downloads; has no effect when “Download scene images” is off.",
    aliases: ["scene images", "download concurrency", "parallel"],
  },
  "download.generateNfo": { label: "Generate NFO", aliases: ["nfo", "metadata file"] },
  "download.nfoNaming": { label: "NFO file naming", aliases: ["nfo", "naming", "metadata file"] },
  "download.nfoIgnoreFields": {
    label: "Excluded NFO fields",
    description:
      "Optional fields that are not written to NFO files; core fields such as title, code and actors are always kept. Leave empty to write all optional fields.",
    aliases: [
      "nfo",
      "metadata file",
      "num",
      "number",
      "plot",
      "release",
      "runtime",
      "technical",
      "rating",
      "studio",
      "director",
      "publisher",
      "series",
      "genres",
      "tags",
      "poster",
      "thumb",
      "fanart",
      "sceneImages",
      "trailer",
      "source",
    ],
  },
  "download.keepThumb": { label: "Keep existing thumbnail" },
  "download.keepPoster": { label: "Keep existing poster" },
  "download.keepFanart": { label: "Keep existing fanart" },
  "download.keepSceneImages": { label: "Keep existing scene images" },
  "download.keepTrailer": { label: "Keep existing trailer" },
  "titleRepair.enabled": {
    label: "Restore masked words in titles and plots",
    description:
      "Restore censorship symbols (●, 〇, etc.) in official titles and plots to the original words (e.g. 「催●」 → 「催眠」, 「●っ払う」 → 「酔っ払う」) before translation; the original title is still kept in the NFO.",
    aliases: ["title repair", "masked title", "masked plot"],
  },
  "titleRepair.stripTrailingActors": {
    label: "Remove actor names from title end",
    description:
      'Some sites append actor names to the title (e.g. "… Yua Mikami"); when enabled they are removed based on the movie\'s actor list.',
    aliases: ["title actors", "actress name"],
  },
  "naming.assetNamingMode": {
    label: "Asset file naming",
    description: "File name rule for posters, thumbnails, fanart and trailers.",
  },
  "naming.nfoTitleTemplate": {
    label: "NFO title template",
    description: "Format of the NFO title field. Available placeholders: {number} {title} {originaltitle}",
  },
  "naming.actorNameMax": { label: "Maximum actor names" },
  "naming.actorNameMore": { label: "Suffix for extra actors" },
  "naming.actorFallbackToStudio": {
    label: "Use studio or seller when no actors",
    description:
      "When on, {actor} falls back to the studio or seller name if there are no actors; use {actorFallbackPrefix}{actor} in templates to show the source.",
  },
  "naming.releaseRule": { label: "Release date format" },
  "naming.folderNameMax": { label: "Maximum folder name length" },
  "naming.fileNameMax": { label: "Maximum file name length" },
  "naming.cnwordStyle": { label: "Chinese subtitle marker" },
  "naming.umrStyle": { label: "UMR marker" },
  "naming.leakStyle": { label: "Leak marker" },
  "naming.uncensoredStyle": { label: "Uncensored marker" },
  "naming.censoredStyle": { label: "Censored marker" },
  "naming.partStyle": {
    label: "Part style",
    description: "Keep the original suffix of multi-part videos, or rewrite it as CD / PART / DISC.",
  },
  "aggregation.behavior.maxSceneImages": {
    label: "Maximum scene images",
    description: "Upper limit of scene images kept after aggregation.",
    aliases: ["aggregation", "scene images", "max"],
  },
  "aggregation.behavior.maxActors": {
    label: "Maximum actors",
    description: "Upper limit of actors kept after aggregation.",
    aliases: ["aggregation", "actors", "max"],
  },
  "aggregation.behavior.maxGenres": {
    label: "Maximum tags",
    description: "Upper limit of genres or tags kept after aggregation.",
    aliases: ["aggregation", "genres", "tags"],
  },
  "translate.enableTranslation": {
    label: "Translate content",
    description:
      "Classic machine translation (DeepL, Baidu) is limited in quality, so an LLM is recommended; you can also leave this off and translate NFOs with another tool later.",
  },
  "translate.fields": {
    label: "Fields to translate",
    description: "Only the selected fields are translated; the rest keep the original text.",
    aliases: ["translation scope"],
  },
  "translate.engine": { label: "Translation engine", aliases: ["translator", "translation"] },
  "translate.llmModelName": { label: "LLM model name", aliases: ["model", "openai", "llm"] },
  "translate.llmApiKey": {
    label: "LLM API key (optional)",
    description:
      "Usually required for the default OpenAI endpoint; whether local or compatible services need a key depends on the server.",
    aliases: ["api key", "token", "openai key"],
  },
  "translate.llmBaseUrl": {
    label: "LLM API URL",
    description: `Default: ${DEFAULT_LLM_BASE_URL}. Google Gemini example: https://generativelanguage.googleapis.com/v1beta/openai. Local example: Ollama uses http://127.0.0.1:11434/v1`,
    aliases: ["base url", "endpoint"],
  },
  "translate.llmApiFormat": { label: "Request format" },
  "translate.llmServiceType": {
    label: "Service type",
    description: "Custom proxies must select Google or DeepSeek explicitly; the URL domain is not used for detection.",
  },
  "translate.llmSystemPrompt": {
    label: "LLM system prompt",
    description:
      "Shared by translation and movie code recognition as a system prompt. Set roles, context, and general instructions; leave blank to omit.",
    aliases: ["prompt", "prefix"],
  },
  "translate.llmPrompt": {
    label: "LLM translation prompt",
    description:
      "Used for text, movie metadata, and batch NFO translation. {lang} is the target language and {content} is the input. Output format instructions are appended automatically.",
    aliases: ["prompt"],
  },
  "translate.llmNumberRecognitionPrompt": {
    label: "LLM movie code fallback prompt",
    description:
      "Used only for AI movie code fallback. The file name, immediate parent folder name, and previous code are appended automatically, with JSON output and source evidence requirements.",
    aliases: ["prompt", "code", "fallback"],
  },
  "translate.llmTemperature": {
    label: "LLM temperature (advanced, optional)",
    description: "Leave empty to use the server default.",
  },
  "translate.llmReasoning": { label: "LLM reasoning effort", aliases: ["reasoning", "thinking"] },
  "translate.llmOutputFormat": {
    label: "Output format",
    description:
      "Prompt JSON omits structured output parameters; metadata translation always requests JSON and validates it locally.",
  },
  "translate.llmTimeout": { label: "LLM request timeout (s)" },
  "translate.llmMaxRetries": { label: "LLM max retries" },
  "translate.llmMaxRequestsPerSecond": { label: "LLM max requests per second" },
  "translate.targetLanguage": { label: "Target language", aliases: ["language", "locale"] },
  "translate.untranslatedJapaneseRunLength": {
    label: "Consecutive Japanese characters for untranslated detection",
    description:
      "Untranslated-only NFO scans require this many consecutive hiragana or katakana characters, including half-width kana and long vowel marks (default: 5). Kanji, spaces and punctuation break the run. Recorded failures are always retried; English and Chinese script conversion alone do not qualify.",
    aliases: ["untranslated", "Japanese", "kana", "threshold", "batch translation"],
  },
  "personSync.personOverviewSources": { label: "Person overview source order" },
  "personSync.personImageSources": { label: "Person photo source order" },
  "personSync.actorAliases": {
    label: "Actor aliases",
    description:
      "Map alternate names to a canonical name for new scrapes and person lookups. Existing files are not renamed.",
    aliases: ["actor name", "alias"],
  },
  "jellyfin.url": { label: "Jellyfin server URL", aliases: ["media server", "jellyfin", "server"] },
  "jellyfin.apiKey": { label: "Jellyfin API Key" },
  "jellyfin.userId": {
    label: "Jellyfin user ID",
    description: "Must be a UUID. Used to read the person list; leave empty to use the server default.",
  },
  "jellyfin.lockOverviewAfterSync": {
    label: "Lock person overview after sync",
    description:
      "After writing the overview, add Overview to LockedFields so Jellyfin metadata refreshes are less likely to overwrite it.",
  },
  "emby.url": { label: "Emby server URL", aliases: ["media server", "emby", "server"] },
  "emby.apiKey": { label: "Emby API Key" },
  "emby.userId": {
    label: "Emby user ID",
    description: "Used to read the person list; leave empty to use the server default.",
  },
  "emby.autoSyncActorPhotos": {
    label: "Automatically sync actor photos",
    description:
      "After publication, notify Emby to scan and fill missing actor photos. Check for actors not yet created every 5 seconds for up to 5 minutes. Existing photos are preserved.",
  },
  "emby.actorPhotoDailySyncTime": {
    label: "Daily actor photo check time",
    description:
      "Optional 24-hour HH:mm (e.g. 03:00) to fill missing Emby actor photos once daily. Leave empty to disable. Uses the MDCz service's time zone and requires automatic sync to be enabled.",
  },
  "emby.notifyAfterPublish": {
    label: "Refresh folder after organizing",
    description:
      "Ask Emby to scan the published movie folder. Scan notifications are always sent when automatic actor photo sync is enabled.",
  },
  "jellyfin.notifyAfterPublish": {
    label: "Refresh folder after organizing",
    description:
      "After a movie is organized into the library, ask Jellyfin to scan just that folder so it appears without a full library refresh.",
  },
  "automation.pathMappings": {
    label: "Downloader path mappings",
    description:
      "When the downloader runs in another container or host, translate the paths it reports into paths MDCz can read. The longest matching prefix wins.",
    aliases: ["remote path", "docker", "qbittorrent"],
  },
  "automation.qbittorrent.url": {
    label: "qBittorrent web UI URL",
    description: "For example http://qbittorrent:8080. Leave empty to stop polling.",
    aliases: ["qbittorrent", "downloader", "torrent"],
  },
  "automation.qbittorrent.apiKey": {
    label: "qBittorrent API key",
    description: "qBittorrent 5.2 or newer. Used instead of the username and password.",
  },
  "automation.qbittorrent.username": {
    label: "qBittorrent username",
    description: "For older versions. Leave empty if qBittorrent skips authentication for MDCz's address.",
  },
  "automation.qbittorrent.password": { label: "qBittorrent password" },
  "automation.qbittorrent.category": {
    label: "Category",
    description:
      "MDCz processes completed torrents in this category only. Its save path must be inside a library's source directory. Avoid sharing this category or path with tools like MoviePilot to prevent file conflicts.",
  },
  "notifications.webhookUrl": {
    label: "Webhook URL",
    description: "Receives every task start and finish as JSON.",
    aliases: ["webhook"],
  },
  "notifications.webhookSecret": {
    label: "Webhook secret",
    description: "Sent in the x-mdcz-webhook-secret header.",
  },
  "notifications.channels": {
    label: "Notification channels",
    description: "Send a notification when a scrape finishes, and the daily digest when enabled.",
  },
  "notifications.telegramBotToken": { label: "Telegram bot token" },
  "notifications.telegramChatId": { label: "Telegram chat ID" },
  "notifications.barkUrl": { label: "Bark URL", description: "Your Bark push URL, including the device key." },
  "notifications.ntfyUrl": { label: "ntfy topic URL", description: "For example https://ntfy.sh/your-topic." },
  "notifications.ntfyToken": { label: "ntfy access token", description: "Leave empty for public topics." },
  "notifications.dailyDigest": {
    label: "Daily digest",
    description: "Once a day, report the movies added in the last day and how many files are pending.",
  },
  "notifications.digestHour": { label: "Digest hour (0-23)", description: "Server local time." },
};

export const settingsFields = {
  sections,
  fields,
  llmReasoningDescription: {
    google:
      "Reasoning fields are omitted by default. Gemini 2.5 Pro and the Gemini 3 series cannot disable reasoning; other models are validated by the server.",
    deepseek:
      "The toggle and effort are omitted by default; enable to use the server's default effort, or pick low / high / max. Temperature has no effect in thinking mode.",
    default:
      "Reasoning fields are omitted by default; whether disabling or a specific effort is available is validated by the model and server.",
  },
  search: {
    filterByGroup: (group: string) => `Filter by group: ${group}`,
    modifiedTokenHint: "Only show settings that differ from their defaults",
    groupTokenHint: "Filter by group, e.g. @group:network",
  },
  quote: (label: string) => `“${label}”`,
};
