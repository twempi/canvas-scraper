// The toolbar icon opens the archive as a side panel; jobs run in that panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
