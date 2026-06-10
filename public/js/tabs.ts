// Tab switching functionality

window.openTab = function (evt: MouseEvent | null, tabName: string): void {
  // Hide all tab contents
  const tabcontent = document.getElementsByClassName('tab-content');
  for (let i = 0; i < tabcontent.length; i++) {
    tabcontent[i].classList.remove('active');
  }

  // Deactivate all tabs
  const tablinks = document.getElementsByClassName('tab');
  for (let i = 0; i < tablinks.length; i++) {
    tablinks[i].classList.remove('active');
  }

  // Show selected tab content
  document.getElementById(tabName)?.classList.add('active');

  // Activate clicked tab button
  if (evt && evt.currentTarget) {
    (evt.currentTarget as HTMLElement).classList.add('active');
  } else {
    // Programmatic call: match by data-tab on the existing tablinks
    // collection. data-tab is set in index.html on each .tab button.
    for (const tab of Array.from(tablinks)) {
      if ((tab as HTMLElement).dataset['tab'] === tabName) {
        tab.classList.add('active');
        break;
      }
    }
  }

  // Trigger logic specific to the activated tab. Optional chaining on
  // every handler so a script that fails to load (network or order)
  // produces a no-op rather than a runtime TypeError.
  if (tabName === 'manage') {
    window.handleManageTabActive?.();
  } else if (tabName === 'download') {
    window.handleDownloadTabActive?.();
  } else if (tabName === 'convert') {
    window.handleConvertTabActive?.();
  } else if (tabName === 'catalog') {
    window.handleCatalogTabActive?.();
  } else if (tabName === 'customCatalogs') {
    window.handleCustomCatalogsTabActive?.();
  }
};
