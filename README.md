# IITC-plugin for planning Drone routes
This script is an add-on for [Ingress Intel Total Conversion (IITC)](https://iitc.app/) and will not work without it.

## Installation
### Prerequisites
1. Any Browser that supports the [Chrome Web Store](https://chrome.google.com/webstore/category/extensions) or [Firefox Addons](https://addons.mozilla.org/en-US/firefox/) ([Google Chrome](http://google.com/chrome), [FireFox](https://www.mozilla.org/en-US/firefox/new/), [Brave](https://brave.com), [Microsoft Edge](https://www.microsoft.com/en-us/edge) (Chromium Version), [Opera](https://www.microsoft.com/en-us/edge), etc.) 
2. [Ingress Account](https://ingress.com/)

### Install
1. Install [IITC](https://iitc.app/download_desktop.html) from [Chrome Web Store](https://chrome.google.com/webstore/detail/iitc-button/febaefghpimpenpigafpolgljcfkeakn) or [Firefox Addons](https://addons.mozilla.org/firefox/addon/iitc-button). 
2. Install [this plugin](https://github.com/tehstone/IngressDronePath/) by clicking [here](https://github.com/tehstone/IngressDronePath/raw/master/dronePathTravelPlanner.user.js?inline=false), then clicking the install button at the top of the new page that appears.
3. Open the [Ingress Intel Map](https://ingress.com/intel) and mouse-over the layer chooser to verify that the "Drone Grid" layer is visible and selected and that the Drone Grid Settings appears in the sidebar 

![Example Screenshot 1](https://i.imgur.com/zNhGWbN.png) ![Example Screenshot 2](https://i.imgur.com/voMW48I.png)

### Using the Plugin
Once the plugin is installed, selecting a portal will draw a 500 meter ring around that portal and draw all Level 16 S2 grid cells that intersect with that circle. All portals within those cells will be highlighted. Any portal that would be a one-way jump from the selected portal will have an additional red highlight.

![Example Screenshot](https://i.imgur.com/jR2MFaa.png)

Additionally, portals can be marked as part of the current route and all portals marked in this way will display on the map with the Drone icon. This mark is saved when the page is refreshed.
![Example Screenshot](https://i.imgur.com/uQbdVEq.png)

### Configuring the Plugin
Selecting the "Drone Grid Settings" Option in the sidebar will show a variety of configuration options:
![Screenshot](https://i.imgur.com/DHkOdkt.png)
