// Central UI translations (single source of truth). Shared by the main process
// and the preloads via require(); renderers receive it through the context
// bridge. Language keys match the store values 'german' / 'english' / 'french'.
//
// Only user-facing UI strings live here. Internal log messages stay as-is and
// the brand name "SHOWhisper" is never translated. {placeholders} are filled
// by t(lang, key, vars).

const translations = {
  german: {
    'menu.settings': 'Einstellungen…',
    'menu.autostart': 'Beim Anmelden starten',
    'menu.model': 'Modell',
    'menu.quit': 'Beenden',

    'tray.loading': 'Lade {model}…',
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

    'settings.title': 'SHOWhisper – Einstellungen',
    'settings.heading': '🎙 SHOWhisper – Einstellungen',
    'settings.language.label': 'Transkriptions-Sprache',
    'settings.language.hint': 'Sprache, in der du sprichst und die transkribiert wird.',
    'settings.provider.label': 'Modell-Provider',
    'settings.provider.xenova': 'Xenova (public, kein Token nötig)',
    'settings.provider.onnx': 'onnx-community (neuere Modelle, Token empfohlen)',
    'settings.provider.hint': 'Bestimmt von welchem HuggingFace-Namespace die Whisper-Modelle geladen werden.',
    'settings.token.label': 'HuggingFace Read-Token',
    'settings.token.hint': 'Nur nötig für onnx-community oder gated models.',
    'settings.token.create': 'Token erstellen →',

    'lang.german': 'Deutsch',
    'lang.english': 'Englisch',
    'lang.french': 'Französisch',

    'btn.cancel': 'Abbrechen',
    'btn.save': 'Speichern & Modell neu laden',

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
  },

  english: {
    'menu.settings': 'Settings…',
    'menu.autostart': 'Launch at login',
    'menu.model': 'Model',
    'menu.quit': 'Quit',

    'tray.loading': 'Loading {model}…',
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

    'settings.title': 'SHOWhisper – Settings',
    'settings.heading': '🎙 SHOWhisper – Settings',
    'settings.language.label': 'Transcription language',
    'settings.language.hint': 'The language you speak and that gets transcribed.',
    'settings.provider.label': 'Model provider',
    'settings.provider.xenova': 'Xenova (public, no token needed)',
    'settings.provider.onnx': 'onnx-community (newer models, token recommended)',
    'settings.provider.hint': 'Determines which HuggingFace namespace the Whisper models are loaded from.',
    'settings.token.label': 'HuggingFace read token',
    'settings.token.hint': 'Only needed for onnx-community or gated models.',
    'settings.token.create': 'Create token →',

    'lang.german': 'German',
    'lang.english': 'English',
    'lang.french': 'French',

    'btn.cancel': 'Cancel',
    'btn.save': 'Save & reload model',

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
  },

  french: {
    'menu.settings': 'Réglages…',
    'menu.autostart': 'Lancer à la connexion',
    'menu.model': 'Modèle',
    'menu.quit': 'Quitter',

    'tray.loading': 'Chargement de {model}…',
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

    'settings.title': 'SHOWhisper – Réglages',
    'settings.heading': '🎙 SHOWhisper – Réglages',
    'settings.language.label': 'Langue de transcription',
    'settings.language.hint': 'La langue que vous parlez et qui est transcrite.',
    'settings.provider.label': 'Fournisseur du modèle',
    'settings.provider.xenova': 'Xenova (public, aucun jeton requis)',
    'settings.provider.onnx': 'onnx-community (modèles récents, jeton recommandé)',
    'settings.provider.hint': 'Détermine depuis quel espace de noms HuggingFace les modèles Whisper sont chargés.',
    'settings.token.label': 'Jeton de lecture HuggingFace',
    'settings.token.hint': 'Nécessaire uniquement pour onnx-community ou les modèles à accès restreint.',
    'settings.token.create': 'Créer un jeton →',

    'lang.german': 'Allemand',
    'lang.english': 'Anglais',
    'lang.french': 'Français',

    'btn.cancel': 'Annuler',
    'btn.save': 'Enregistrer et recharger le modèle',

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
