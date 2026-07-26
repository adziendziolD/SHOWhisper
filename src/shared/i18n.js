// Central UI translations (single source of truth). Shared by the main process
// and the preloads via require(); renderers receive it through the context
// bridge. Language keys match the store values 'german' / 'english' / 'french'.
//
// Only user-facing UI strings live here. Internal log messages stay as-is and
// the brand name "SHOWhisper" is never translated. {placeholders} are filled
// by t(lang, key, vars).

const translations = {
  german: {
    'menu.transcribeFile': 'Datei transkribieren…',
    'menu.settings': 'Einstellungen…',
    'menu.autostart': 'Beim Anmelden starten',
    'menu.model': 'Modell',
    'menu.quit': 'Beenden',

    'tray.loading': 'Lade {model}…',
    'tray.loadingLlm': 'Lade Zusammenfassungs-Modell…',
    'tray.loadError': 'Fehler beim Laden',
    'tray.hotkeyUnavailable': 'Hotkey ⌥Leertaste belegt',

    'dialog.modelError.title': 'Modell konnte nicht geladen werden',
    'dialog.modelError.body': '{model} konnte nicht geladen werden:\n{error}',
    'dialog.mic.title': 'Mikrofon nicht verfügbar',
    'dialog.mic.body': 'Die Aufnahme konnte nicht gestartet werden:\n{error}\n\nBitte Mikrofon-Zugriff erlauben unter:\nSystemeinstellungen → Datenschutz & Sicherheit → Mikrofon',
    'dialog.a11y.title': 'Accessibility-Zugriff benötigt',
    'dialog.a11y.body': 'SHOWhisper benötigt Zugriff auf Bedienungshilfen, um den transkribierten Text automatisch einzufügen. Ohne diesen Zugriff bleibt der Text zum manuellen Einfügen in der Zwischenablage.\n\nBitte erlaube den Zugriff unter:\nSystemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen',
    'dialog.a11y.open': 'Öffnen',
    'dialog.hotkey.title': 'Hotkey nicht verfügbar',
    'dialog.hotkey.body': 'Der Hotkey ⌥Leertaste ist bereits von einer anderen App belegt. Das Diktat lässt sich daher nicht per Tastenkürzel starten.',

    'overlay.loading': 'Modell wird geladen…',
    'overlay.transcribing': 'Wird transkribiert…',
    'overlay.summarizing': 'Wird zusammengefasst…',

    'settings.title': 'SHOWhisper – Einstellungen',
    'settings.heading': '🎙 SHOWhisper – Einstellungen',
    'settings.language.label': 'Transkriptions-Sprache',
    'settings.language.hint': 'Sprache, in der du sprichst und die transkribiert wird.',

    'lang.german': 'Deutsch',
    'lang.english': 'Englisch',
    'lang.french': 'Französisch',

    'cache.title': 'Modell-Cache',
    'cache.openFolder': 'Ordner öffnen →',
    'cache.clearAll': 'Alles löschen',
    'cache.empty': 'Keine Modelle gecacht',
    'cache.total': 'gesamt {size}',
    'cache.activeModel': 'aktives Modell – kann nicht gelöscht werden',
    'cache.confirmDelete': '„{model}" ({provider}) aus dem Cache löschen?',
    'cache.confirmClear': 'Alle gecachten Modelle löschen (außer dem aktiven)?',

    'status.modelLoaded': '✓ Modell geladen',
    'status.saved': '✓ gespeichert',
    'status.error': '⚠️ Fehler: {error}',
    'error.unknown': 'Unbekannter Fehler',

    'result.heading': '🎙 SHOWhisper – Datei-Transkription',
    'result.drop': 'Mediendatei hierher ziehen oder auswählen',
    'result.dropHint': 'mp4, mov, mp3, m4a, wav …',
    'result.transcribing': '{name} wird transkribiert…',
    'result.model': 'Transkriptions-Modell für Dateien',
    'result.modelHint': 'Für Dateien lohnt sich ein größeres Modell (genauer). Das Diktat-Modell bleibt davon unberührt.',
    'result.transcript': 'Transkript',
    'result.summary': 'Zusammenfassung',
    'result.summarize': 'Zusammenfassen',
    'result.summarizing': 'Wird zusammengefasst…',
    'result.copy': 'Kopieren',
    'result.save': 'Speichern…',
    'result.copied': '✓ kopiert',
    'result.saved': '✓ gespeichert',
    'result.error': '⚠️ Fehler: {error}',
    'result.modelNotReady': 'Das Transkriptionsmodell wird noch geladen. Bitte kurz warten und erneut versuchen.',
    'result.unsupported': 'Dieses Dateiformat wird nicht unterstützt.',
    'result.mediaFilter': 'Mediendateien',
  },

  english: {
    'menu.transcribeFile': 'Transcribe file…',
    'menu.settings': 'Settings…',
    'menu.autostart': 'Launch at login',
    'menu.model': 'Model',
    'menu.quit': 'Quit',

    'tray.loading': 'Loading {model}…',
    'tray.loadingLlm': 'Loading summary model…',
    'tray.loadError': 'Load failed',
    'tray.hotkeyUnavailable': 'Hotkey ⌥Space unavailable',

    'dialog.modelError.title': 'Model could not be loaded',
    'dialog.modelError.body': '{model} could not be loaded:\n{error}',
    'dialog.mic.title': 'Microphone unavailable',
    'dialog.mic.body': 'Recording could not be started:\n{error}\n\nPlease allow microphone access under:\nSystem Settings → Privacy & Security → Microphone',
    'dialog.a11y.title': 'Accessibility access required',
    'dialog.a11y.body': 'SHOWhisper needs Accessibility access to paste the transcribed text automatically. Without it, the text stays on the clipboard for a manual paste.\n\nPlease allow access under:\nSystem Settings → Privacy & Security → Accessibility',
    'dialog.a11y.open': 'Open',
    'dialog.hotkey.title': 'Hotkey unavailable',
    'dialog.hotkey.body': 'The hotkey ⌥Space is already in use by another app, so dictation cannot be triggered by the keyboard shortcut.',

    'overlay.loading': 'Loading model…',
    'overlay.transcribing': 'Transcribing…',
    'overlay.summarizing': 'Summarizing…',

    'settings.title': 'SHOWhisper – Settings',
    'settings.heading': '🎙 SHOWhisper – Settings',
    'settings.language.label': 'Transcription language',
    'settings.language.hint': 'The language you speak and that gets transcribed.',

    'lang.german': 'German',
    'lang.english': 'English',
    'lang.french': 'French',

    'cache.title': 'Model cache',
    'cache.openFolder': 'Open folder →',
    'cache.clearAll': 'Clear all',
    'cache.empty': 'No models cached',
    'cache.total': 'total {size}',
    'cache.activeModel': 'active model – cannot be deleted',
    'cache.confirmDelete': 'Delete "{model}" ({provider}) from the cache?',
    'cache.confirmClear': 'Delete all cached models (except the active one)?',

    'status.modelLoaded': '✓ Model loaded',
    'status.saved': '✓ Saved',
    'status.error': '⚠️ Error: {error}',
    'error.unknown': 'Unknown error',

    'result.heading': '🎙 SHOWhisper – File transcription',
    'result.drop': 'Drag a media file here or choose one',
    'result.dropHint': 'mp4, mov, mp3, m4a, wav …',
    'result.transcribing': 'Transcribing {name}…',
    'result.model': 'File transcription model',
    'result.modelHint': 'A larger model is worth it for files (more accurate). Your dictation model is left unchanged.',
    'result.transcript': 'Transcript',
    'result.summary': 'Summary',
    'result.summarize': 'Summarize',
    'result.summarizing': 'Summarizing…',
    'result.copy': 'Copy',
    'result.save': 'Save…',
    'result.copied': '✓ copied',
    'result.saved': '✓ saved',
    'result.error': '⚠️ Error: {error}',
    'result.modelNotReady': 'The transcription model is still loading. Please wait a moment and try again.',
    'result.unsupported': 'This file format is not supported.',
    'result.mediaFilter': 'Media files',
  },

  french: {
    'menu.transcribeFile': 'Transcrire un fichier…',
    'menu.settings': 'Réglages…',
    'menu.autostart': 'Lancer à la connexion',
    'menu.model': 'Modèle',
    'menu.quit': 'Quitter',

    'tray.loading': 'Chargement de {model}…',
    'tray.loadingLlm': 'Chargement du modèle de résumé…',
    'tray.loadError': 'Échec du chargement',
    'tray.hotkeyUnavailable': 'Raccourci ⌥Espace indisponible',

    'dialog.modelError.title': 'Impossible de charger le modèle',
    'dialog.modelError.body': 'Impossible de charger {model} :\n{error}',
    'dialog.mic.title': 'Microphone indisponible',
    'dialog.mic.body': "Impossible de démarrer l'enregistrement :\n{error}\n\nVeuillez autoriser l'accès au microphone dans :\nRéglages Système → Confidentialité et sécurité → Microphone",
    'dialog.a11y.title': "Accès à l'accessibilité requis",
    'dialog.a11y.body': "SHOWhisper a besoin de l'accès à l'accessibilité pour coller automatiquement le texte transcrit. Sans cet accès, le texte reste dans le presse-papiers pour un collage manuel.\n\nVeuillez autoriser l'accès dans :\nRéglages Système → Confidentialité et sécurité → Accessibilité",
    'dialog.a11y.open': 'Ouvrir',
    'dialog.hotkey.title': 'Raccourci indisponible',
    'dialog.hotkey.body': "Le raccourci ⌥Espace est déjà utilisé par une autre application. La dictée ne peut donc pas être déclenchée par le raccourci clavier.",

    'overlay.loading': 'Chargement du modèle…',
    'overlay.transcribing': 'Transcription…',
    'overlay.summarizing': 'Résumé en cours…',

    'settings.title': 'SHOWhisper – Réglages',
    'settings.heading': '🎙 SHOWhisper – Réglages',
    'settings.language.label': 'Langue de transcription',
    'settings.language.hint': 'La langue que vous parlez et qui est transcrite.',

    'lang.german': 'Allemand',
    'lang.english': 'Anglais',
    'lang.french': 'Français',

    'cache.title': 'Cache des modèles',
    'cache.openFolder': 'Ouvrir le dossier →',
    'cache.clearAll': 'Tout supprimer',
    'cache.empty': 'Aucun modèle en cache',
    'cache.total': 'total {size}',
    'cache.activeModel': 'modèle actif – suppression impossible',
    'cache.confirmDelete': 'Supprimer « {model} » ({provider}) du cache ?',
    'cache.confirmClear': "Supprimer tous les modèles en cache (sauf l'actif) ?",

    'status.modelLoaded': '✓ Modèle chargé',
    'status.saved': '✓ Enregistré',
    'status.error': '⚠️ Erreur : {error}',
    'error.unknown': 'Erreur inconnue',

    'result.heading': '🎙 SHOWhisper – Transcription de fichier',
    'result.drop': 'Glissez un fichier média ici ou sélectionnez-en un',
    'result.dropHint': 'mp4, mov, mp3, m4a, wav …',
    'result.transcribing': 'Transcription de {name}…',
    'result.model': 'Modèle de transcription pour les fichiers',
    'result.modelHint': 'Pour les fichiers, un modèle plus grand est utile (plus précis). Votre modèle de dictée reste inchangé.',
    'result.transcript': 'Transcription',
    'result.summary': 'Résumé',
    'result.summarize': 'Résumer',
    'result.summarizing': 'Résumé en cours…',
    'result.copy': 'Copier',
    'result.save': 'Enregistrer…',
    'result.copied': '✓ copié',
    'result.saved': '✓ enregistré',
    'result.error': '⚠️ Erreur : {error}',
    'result.modelNotReady': 'Le modèle de transcription est encore en cours de chargement. Veuillez patienter et réessayer.',
    'result.unsupported': 'Ce format de fichier n\'est pas pris en charge.',
    'result.mediaFilter': 'Fichiers média',
  },
}

// Look up a key for a language, falling back to German and then the raw key.
// {name} placeholders are replaced from vars.
function t(lang, key, vars) {
  const dict = translations[lang] || translations.german
  let str = dict[key] || translations.german[key] || key
  if (vars) {
    for (const name of Object.keys(vars)) {
      str = str.split('{' + name + '}').join(vars[name])
    }
  }
  return str
}

module.exports = { translations, t }
