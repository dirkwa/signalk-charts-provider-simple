// Tab switching functionality

window.openTab = function(evt, tabName) {
    let i, tabcontent, tablinks;

    // Hide all tab contents
    tabcontent = document.getElementsByClassName("tab-content");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].classList.remove('active');
    }

    // Deactivate all tabs
    tablinks = document.getElementsByClassName("tab");
    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].classList.remove('active');
    }

    // Show selected tab content
    document.getElementById(tabName).classList.add('active');

    // Activate clicked tab button
    if (evt && evt.currentTarget) {
        evt.currentTarget.classList.add('active');
    } else {
        // Find and activate the matching tab button
        const tabs = document.getElementsByClassName("tab");
        for (let tab of tabs) {
            if (tab.onclick && tab.onclick.toString().includes(tabName)) {
                tab.classList.add('active');
                break;
            }
        }
    }

    // Trigger logic specific to the activated tab
    if (tabName === 'bruce-locker') {
        window.handleChartLockerTabActive();
    } else if (tabName === 'manage') {
        window.handleManageTabActive();
    } else if (tabName === 'download') {
        window.handleDownloadTabActive();
    }
}
