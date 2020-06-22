// ==UserScript==
// @id dronePathTravelPlanner
// @name IITC Plugin: Drone Travel Path Planner
// @category Tweaks
// @version 0.14.0
// @namespace	https://github.com/tehstone/IngressDronePath
// @downloadURL	https://github.com/tehstone/IngressDronePath/raw/master/dronePathTravelPlanner.user.js
// @homepageURL	https://github.com/tehstone/IngressDronePath
// @description Shows drone travel range from selected portal
// @author tehstone
// @include		https://intel.ingress.com/*
// @match		https://intel.ingress.com/*
// @grant			none
// ==/UserScript==

/* globals dialog */

// Wrapper function that will be stringified and injected
// into the document. Because of this, normal closure rules
// do not apply here.
function wrapper(plugin_info) {
	// Make sure that window.plugin exists. IITC defines it as a no-op function,
	// and other plugins assume the same.
	if (typeof window.plugin !== "function") window.plugin = function () {};

	const KEY_SETTINGS = "plugin-drone-path-planner-settings";
	const KEY_ROUTES = "plugin-drone-path-planner-routes"
	const THEORETICAL_KEY_RANGE = 1250;

	// Use own namespace for plugin
	window.plugin.DronePathTravelPlanner = function () {};

	const thisPlugin = window.plugin.DronePathTravelPlanner;

	// Name of the IITC build for first-party plugins
	plugin_info.buildName = "DronePathTravelPlanner";

	// Datetime-derived version of the plugin
	plugin_info.dateTimeVersion = "20190101000000";

	// ID/name of the plugin
	plugin_info.pluginId = "dronepathtravelplanner";

	const TIMERS = {};
	function createThrottledTimer(name, callback, ms) {
		if (TIMERS[name]) clearTimeout(TIMERS[name]);

		// throttle if there are several calls to the functions
		TIMERS[name] = setTimeout(function () {
			delete TIMERS[name];
			if (typeof window.requestIdleCallback == "undefined") callback();
			// and even now, wait for iddle
			else
				requestIdleCallback(
					function () {
						callback();
					},
					{ timeout: 2000 }
				);
		}, ms || 100);
	}

	let routePortals = {};
	let savedRoutes = {};
	window.portalDroneIndicator	= null;
	window.portalDroneIndicatorKey = null;
	droneLayer = null;
	dGridLayerGroup = null;
	let routeLayerGroup;
	let routeLayers = {};
	let lastPortalGuid = null;

	let drawnCells = {};

	map = window.map;
	calculationMethods =
	{
		"500/16": {"radius": 500, "gridSize": 16},
		"570/17": {"radius": 570, "gridSize": 17}
	}

	const defaultSettings = {
		circleColor: "#800080",
		circleWidth: 2,
		gridColor: "#00FF00",
		gridWidth: 2,
		calculationMethod: "500/16",
		portalHighlight: "#f228ef",
		keyRange: false,
		showOneWay: true,
	};

	let settings = defaultSettings;

	function saveSettings() {
		createThrottledTimer("saveSettings", function () {
			localStorage[KEY_SETTINGS] = JSON.stringify(settings);
		});
		drawDroneRange(lastPortalGuid);
	}

	thisPlugin.loadSettings = function() {
		const tmp = localStorage[KEY_SETTINGS];
		try {
			settings = JSON.parse(tmp);
		} catch (e) {
			// eslint-disable-line no-empty
		}
		if (!settings.circleWidth) {
			settings.circleWidth = "2";
		}
		if (!settings.gridWidth) {
			settings.gridWidth = "2";
		}
		if (!settings.portalHighlight) {
			settings.portalHighlight ="#f228ef"
		}
		if (!"keyRange" in settings) {
			settings.keyRange = false
		}
		if (!"showOneWay" in settings) {
			settings.showOneWay = true
		}
	}

	window.resetSettings = function() {
		settings = JSON.parse(JSON.stringify(defaultSettings));
		showSettingsDialog();
	}

	thisPlugin.saveRoutes = function() {
		createThrottledTimer('saveRoutes', function () {
			localStorage[KEY_ROUTES] = JSON.stringify({
				currentRoute: routePortals,
				savedRoutes: savedRoutes,
			});
		});
	}

	thisPlugin.loadRoutes = function() {
		const tmp = JSON.parse(localStorage[KEY_ROUTES] || '{}');
		routePortals = tmp.currentRoute || {};
		savedRoutes = tmp.savedRoutes || {};
	}

	const d2r = Math.PI / 180.0;
	const r2d = 180.0 / Math.PI;

	if (!window.S2) {
		(function () {
		window.S2 = {};

		function LatLngToXYZ(latLng) {
			const phi = latLng.lat * d2r;
			const theta = latLng.lng * d2r;
			const cosphi = Math.cos(phi);

			return [Math.cos(theta) * cosphi, Math.sin(theta) * cosphi, Math.sin(phi)];
		}



		function XYZToLatLng(xyz) {
			const lat = Math.atan2(xyz[2], Math.sqrt(xyz[0] * xyz[0] + xyz[1] * xyz[1]));
			const lng = Math.atan2(xyz[1], xyz[0]);

			return {lat: lat * r2d, lng: lng * r2d};
		}

		function largestAbsComponent(xyz) {
			const temp = [Math.abs(xyz[0]), Math.abs(xyz[1]), Math.abs(xyz[2])];

			if (temp[0] > temp[1]) {
				if (temp[0] > temp[2]) {
					return 0;
				}
				return 2;
			}

			if (temp[1] > temp[2]) {
				return 1;
			}

			return 2;
		}

		function faceXYZToUV(face,xyz) {
			let u, v;

			switch (face) {
				case 0: u =	xyz[1] / xyz[0]; v =	xyz[2] / xyz[0]; break;
				case 1: u = -xyz[0] / xyz[1]; v =	xyz[2] / xyz[1]; break;
				case 2: u = -xyz[0] / xyz[2]; v = -xyz[1] / xyz[2]; break;
				case 3: u =	xyz[2] / xyz[0]; v =	xyz[1] / xyz[0]; break;
				case 4: u =	xyz[2] / xyz[1]; v = -xyz[0] / xyz[1]; break;
				case 5: u = -xyz[1] / xyz[2]; v = -xyz[0] / xyz[2]; break;
				default: throw {error: 'Invalid face'};
			}

			return [u,v];
		}

		function XYZToFaceUV(xyz) {
			let face = largestAbsComponent(xyz);

			if (xyz[face] < 0) {
				face += 3;
			}

			const uv = faceXYZToUV(face, xyz);

			return [face, uv];
		}

		function FaceUVToXYZ(face, uv) {
			const u = uv[0];
			const v = uv[1];

			switch (face) {
				case 0: return [1, u, v];
				case 1: return [-u, 1, v];
				case 2: return [-u,-v, 1];
				case 3: return [-1,-v,-u];
				case 4: return [v,-1,-u];
				case 5: return [v, u,-1];
				default: throw {error: 'Invalid face'};
			}
		}

		function STToUV(st) {
			const singleSTtoUV = function (st) {
				if (st >= 0.5) {
					return (1 / 3.0) * (4 * st * st - 1);
				}
				return (1 / 3.0) * (1 - (4 * (1 - st) * (1 - st)));

			};

			return [singleSTtoUV(st[0]), singleSTtoUV(st[1])];
		}

		function UVToST(uv) {
			const singleUVtoST = function (uv) {
				if (uv >= 0) {
					return 0.5 * Math.sqrt (1 + 3 * uv);
				}
				return 1 - 0.5 * Math.sqrt (1 - 3 * uv);

			};

			return [singleUVtoST(uv[0]), singleUVtoST(uv[1])];
		}

		function STToIJ(st,order) {
			const maxSize = 1 << order;

			const singleSTtoIJ = function (st) {
				const ij = Math.floor(st * maxSize);
				return Math.max(0, Math.min(maxSize - 1, ij));
			};

			return [singleSTtoIJ(st[0]), singleSTtoIJ(st[1])];
		}

		function IJToST(ij,order,offsets) {
			const maxSize = 1 << order;

			return [
				(ij[0] + offsets[0]) / maxSize,
				(ij[1] + offsets[1]) / maxSize
			];
		}

		// S2Cell class
		S2.S2Cell = function () {};

		//static method to construct
		S2.S2Cell.FromLatLng = function (latLng, level) {
			const xyz = LatLngToXYZ(latLng);
			const faceuv = XYZToFaceUV(xyz);
			const st = UVToST(faceuv[1]);
			const ij = STToIJ(st,level);

			return S2.S2Cell.FromFaceIJ(faceuv[0], ij, level);
		};

		S2.S2Cell.FromFaceIJ = function (face, ij, level) {
			const cell = new S2.S2Cell();
			cell.face = face;
			cell.ij = ij;
			cell.level = level;

			return cell;
		};

		S2.S2Cell.prototype.toString = function () {
			return 'F' + this.face + 'ij[' + this.ij[0] + ',' + this.ij[1] + ']@' + this.level;
		};

		S2.S2Cell.prototype.getLatLng = function () {
			const st = IJToST(this.ij, this.level, [0.5, 0.5]);
			const uv = STToUV(st);
			const xyz = FaceUVToXYZ(this.face, uv);

			return XYZToLatLng(xyz);
		};

		S2.S2Cell.prototype.getCornerLatLngs = function () {
			const offsets = [
				[0.0, 0.0],
				[0.0, 1.0],
				[1.0, 1.0],
				[1.0, 0.0]
			];

			return offsets.map(offset => {
				const st = IJToST(this.ij, this.level, offset);
				const uv = STToUV(st);
				const xyz = FaceUVToXYZ(this.face, uv);

				return XYZToLatLng(xyz);
			});
		};

		S2.S2Cell.prototype.getNeighbors = function (deltas) {

			const fromFaceIJWrap = function (face,ij,level) {
				const maxSize = 1 << level;
				if (ij[0] >= 0 && ij[1] >= 0 && ij[0] < maxSize && ij[1] < maxSize) {
					// no wrapping out of bounds
					return S2.S2Cell.FromFaceIJ(face,ij,level);
				}

				// the new i,j are out of range.
				// with the assumption that they're only a little past the borders we can just take the points as
				// just beyond the cube face, project to XYZ, then re-create FaceUV from the XYZ vector
				let st = IJToST(ij,level,[0.5, 0.5]);
				let uv = STToUV(st);
				let xyz = FaceUVToXYZ(face, uv);
				const faceuv = XYZToFaceUV(xyz);
				face = faceuv[0];
				uv = faceuv[1];
				st = UVToST(uv);
				ij = STToIJ(st,level);
				return S2.S2Cell.FromFaceIJ(face, ij, level);
			};

			const face = this.face;
			const i = this.ij[0];
			const j = this.ij[1];
			const level = this.level;

			if (!deltas) {
				deltas = [
					{a: -1, b: 0},
					{a: 0, b: -1},
					{a: 1, b: 0},
					{a: 0, b: 1}
				];
			}
			return deltas.map(function (values) {
				return fromFaceIJWrap(face, [i + values.a, j + values.b], level);
			});
		};
		})();
	}

	function getCellFaceMidpointLatLngs(corners) {
		let midpoints = [];
		corners[4] = corners[0];
		for (let i=0; i < 4; i++) {
			const mlat = (corners[i].lat + corners[i+1].lat) / 2
			const mlng = (corners[i].lng + corners[i+1].lng) / 2
			midpoints.push({"lat": mlat, "lng": mlng});
		}
		return midpoints;
	}

	function getCellFaceQuarterpointLatLngs(corners) {
		let quarterpoints = [];
		corners[4] = corners[0];
		for (let i=0; i < 4; i++) {
			const mlat = (corners[i].lat + corners[i+1].lat) / 2
			const mlng = (corners[i].lng + corners[i+1].lng) / 2
			const qlat1 = (corners[i].lat + mlat) / 2
			const qlng1 = (corners[i].lng + mlng) / 2
			const qlat2 = (mlat + corners[i+1].lat) / 2
			const qlng2 = (mlng + corners[i+1].lng) / 2
			quarterpoints.push({"lat": qlat1, "lng": qlng1});
			quarterpoints.push({"lat": qlat2, "lng": qlng2});
		}
		return quarterpoints;
	}

	function initSvgIcon() {
		L.DivIcon.SVGIcon = L.DivIcon.extend({
			options: {
				'className': 'svg-icon',
				'iconAnchor': null, //defaults to [iconSize.x/2, iconSize.y] (point tip)
				'iconSize': L.point(48, 48)
			},
			initialize: function (options) {
				options = L.Util.setOptions(this, options);

				//iconSize needs to be converted to a Point object if it is not passed as one
				options.iconSize = L.point(options.iconSize);

				if (!options.iconAnchor) {
					options.iconAnchor = L.point(Number(options.iconSize.x) / 2, Number(options.iconSize.y));
				} else {
					options.iconAnchor = L.point(options.iconAnchor);
				}
			},

			// https://github.com/tonekk/Leaflet-Extended-Div-Icon/blob/master/extended.divicon.js#L13
			createIcon: function (oldIcon) {
				let div = L.DivIcon.prototype.createIcon.call(this, oldIcon);

				if (this.options.id) {
					div.id = this.options.id;
				}

				if (this.options.style) {
					for (let key in this.options.style) {
						div.style[key] = this.options.style[key];
					}
				}
				return div;
			}
		});

		L.divIcon.svgIcon = function (options) {
			return new L.DivIcon.SVGIcon(options);
		};

		L.Marker.SVGMarker = L.Marker.extend({
			options: {
				'iconFactory': L.divIcon.svgIcon,
				'iconOptions': {}
			},
			initialize: function (latlng, options) {
				options = L.Util.setOptions(this, options);
				options.icon = options.iconFactory(options.iconOptions);
				this._latlng = latlng;
			},
			onAdd: function (map) {
				L.Marker.prototype.onAdd.call(this, map);
			}
		});

		L.marker.svgMarker = function (latlng, options) {
			return new L.Marker.SVGMarker(latlng, options);
		};
	}

	// The entry point for this plugin.
	function setup() {
		thisPlugin.loadSettings();
		thisPlugin.loadRoutes();

		initSvgIcon();

		window.addHook(
			"portalSelected",
			window.drawDroneRange
		);

		window.addHook('portalSelected', thisPlugin.addToPortalDetails);

		droneLayer = L.layerGroup();
		window.addLayerGroup('Drone Grid', droneLayer, true);
		dGridLayerGroup = L.layerGroup();

		routeLayerGroup = L.layerGroup();
		window.addLayerGroup('Drone Route', routeLayerGroup, true);

		const toolbox = document.getElementById("toolbox");

		let buttonDrone = document.createElement("a");
		buttonDrone.textContent = "Drone Grid Settings";
		buttonDrone.title = "Configuration for Drone Path Plugin";
		buttonDrone.addEventListener("click", showSettingsDialog);
		toolbox.appendChild(buttonDrone);
		buttonDrone = document.createElement("a");
		buttonDrone.textContent = "Drone Grid Actions";
		buttonDrone.title = "Actions for Drone Path Plugin";
		buttonDrone.addEventListener("click", showActionsDialog);
		toolbox.appendChild(buttonDrone);
		thisPlugin.setupCSS();

		thisPlugin.addAllMarkers();
	}

	thisPlugin.onPortalSelectedPending = false;
	thisPlugin.addToPortalDetails = function () {
		const portalDetails = document.getElementById('portaldetails');

		if (window.selectedPortal == null) {
			return;
		}


	}

	thisPlugin.updateStarPortal = function () {
		$('.droneRoute').removeClass('favorite');
		const guid = window.selectedPortal;
		if (routePortals[guid]) {
			$('.droneRoute').addClass('favorite');
		}
	}

	thisPlugin.switchStarPortal = function (type) {
		const guid = window.selectedPortal;

		if (routePortals[guid]) {
			delete routePortals[guid];
			let starInLayer = routeLayers[guid];
			routeLayerGroup.removeLayer(starInLayer);
			delete routeLayers[guid];
			starInLayer = routeLayers[guid+"l"];
			routeLayerGroup.removeLayer(starInLayer);
			delete routeLayers[guid+"l"];
		} else {
			const p = window.portals[guid];
			const ll = p.getLatLng();
			thisPlugin.addPortalToRoute(guid, ll.lat, ll.lng, p.options.data.title, type);
		}
		thisPlugin.updateStarPortal();
		thisPlugin.saveRoutes();
	}

	thisPlugin.addPortalToRoute = function (guid, lat, lng, name, type) {
		// Add pogo in the localStorage
		const obj = {'guid': guid, 'lat': lat, 'lng': lng, 'name': name};

		// prevent that it would trigger the missing portal detection if it's in our data
		if (window.portals[guid]) {
			obj.exists = true;
		}

		if (type == 'route') {
			routePortals[guid] = obj;
		}

		//saveStorage();
		thisPlugin.updateStarPortal();

		thisPlugin.addStar(guid, lat, lng, name, type);
	};

	thisPlugin.addStar = function (guid, lat, lng, name, type) {
		let star;
		let starl;
		if (type === 'route') {
			const route = routePortals[guid];

			star = new L.Marker.SVGMarker([lat, lng], {
				title: name,
				iconOptions: {
					className: 'route',
					html: `<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 151.56 128">
<defs><style>.cls-1{fill:#fff;}.cls-2{fill:#fff;}</style></defs>
<path class="cls-1" d="M100.52,82.83a40.09,40.09,0,0,0-10.58,37.76h-4.1a44.22,44.22,0,0,1,27.75-50.78l2,3.53A40,40,0,0,0,100.52,82.83Z"/>
<path class="cls-1" d="M111.48,93.79a24.56,24.56,0,0,0-5.27,26.8h-5.33A29.47,29.47,0,0,1,121,82.67l2.59,4.5A24.41,24.41,0,0,0,111.48,93.79Z"/>
<path class="cls-1" d="M69.4,111.11a43.13,43.13,0,0,1-1,9.48H64.3A40,40,0,0,0,38.2,73.21l2-3.53A44,44,0,0,1,69.4,111.11Z"/>
<path class="cls-1" d="M54.9,111.11a28.87,28.87,0,0,1-1.57,9.48H48a24.51,24.51,0,0,0-17.8-33.51l2.62-4.52A29.49,29.49,0,0,1,54.9,111.11Z"/>
<path class="cls-1" d="M105.22,55.31a44,44,0,0,1-56.44-.42l2-3.54a40,40,0,0,0,52.37.43Z"/>
<path class="cls-1" d="M97.82,42.48A29.5,29.5,0,0,1,56.21,42l2.62-4.54c.35.41.72.8,1.1,1.18a24.5,24.5,0,0,0,34.64,0v0c.22-.22.43-.44.64-.67Z"/>
<circle class="cls-1" cx="128.78" cy="111.11" r="17"/>
<circle class="cls-1" cx="25.37" cy="111.11" r="17"/>
<circle class="cls-1" cx="77.22" cy="21.33" r="17"/>
<path class="cls-2" d="M89.81,111.14a39.07,39.07,0,0,1,11.42-27.6l-.71-.71.71.71a39,39,0,0,1,14.69-9.26l1.13-.39-3-5.31-.79.29a45,45,0,0,0-29.41,42.21v.23a43.93,43.93,0,0,0,1,9.49l.17.79h6.17l-.3-1.24A39,39,0,0,1,89.81,111.14Zm-4,0h0v0a43,43,0,0,1,27.31-40l1,1.76a41.22,41.22,0,0,0-14.34,9.3h0a40.89,40.89,0,0,0-11.1,37.47h-2a42.67,42.67,0,0,1-.83-8.28Z"/>
<path class="cls-2" d="M123.82,88.15l1.34-.29L121.5,81.5l-.74.21A30.46,30.46,0,0,0,98.31,111.1h0v0a30,30,0,0,0,1.63,9.76l.23.68h7.54l-.57-1.39a23.49,23.49,0,0,1,5-25.7l-.71-.71.71.71A23.35,23.35,0,0,1,123.82,88.15Zm-13,4.93h0a25.52,25.52,0,0,0-6,26.51h-3.13a28.08,28.08,0,0,1-1.32-8.44v0h0a28.44,28.44,0,0,1,20.25-27.23l1.53,2.66A25.44,25.44,0,0,0,110.77,93.08Z"/>
<path class="cls-2" d="M70.4,111.11A45,45,0,0,0,40.54,68.74l-.79-.28-3,5.31,1.14.39A39,39,0,0,1,64.45,111.1a38.68,38.68,0,0,1-1.12,9.25l-.3,1.24h6.18l.17-.79a44.57,44.57,0,0,0,1-9.5v-.19Zm-2.82,8.48h-2A40.84,40.84,0,0,0,39.66,72.67l1-1.75A43,43,0,0,1,68.4,111.11h0v.19A42.68,42.68,0,0,1,67.58,119.59Z"/>
<path class="cls-2" d="M33.06,81.59l-.73-.19-3.7,6.39,1.37.27a24.38,24.38,0,0,1,4.48,1.37A23.5,23.5,0,0,1,47.07,120.2l-.58,1.39h7.56l.23-.68a30.27,30.27,0,0,0,1.62-9.76v0h0A30.49,30.49,0,0,0,33.06,81.59Zm19.53,38H49.45a25.5,25.5,0,0,0-14.2-32,25.85,25.85,0,0,0-3.51-1.18l1.54-2.66A28.47,28.47,0,0,1,53.9,111.11h0v0A28.07,28.07,0,0,1,52.59,119.59Z"/>
<path class="cls-2" d="M106.52,55.54l-.43-.74-2.68-4.55-.91.77a39,39,0,0,1-51.06-.42l-.92-.82-3,5.34.63.53a45,45,0,0,0,57.72.43Zm-56.45-.89,1-1.76a41,41,0,0,0,51.82.4l1,1.77a43,43,0,0,1-53.85-.41Z"/>
<path class="cls-2" d="M77.26,51.83A30.4,30.4,0,0,0,98.52,43.2l.56-.55L98.69,42l-3.28-5.69-.93,1q-.28.31-.6.63h0a23.49,23.49,0,0,1-33.22,0c-.37-.37-.72-.74-1-1.12l-.92-1.08L55,42.16l.53.54A30.4,30.4,0,0,0,77.26,51.83Zm0-5A25.42,25.42,0,0,0,95,39.61l1.55,2.68a28.46,28.46,0,0,1-39.09-.47L59,39.13l.21.22A25.39,25.39,0,0,0,77.26,46.82Z"/>
<path class="cls-2" d="M128.78,99.11a12,12,0,1,0,12,12A12,12,0,0,0,128.78,99.11Zm7.07,19.07a10,10,0,1,1,2.93-7.07A10,10,0,0,1,135.85,118.18Z"/>
<path class="cls-2" d="M25.37,99.11a12,12,0,1,0,12,12A12,12,0,0,0,25.37,99.11Zm7.07,19.07a10,10,0,1,1,2.93-7.07A10,10,0,0,1,32.44,118.18Z"/>
<path class="cls-2" d="M77.22,33.33a12,12,0,1,0-12-12A12,12,0,0,0,77.22,33.33ZM70.15,14.26a10,10,0,1,1-2.93,7.07A10,10,0,0,1,70.15,14.26Z"/></svg>`,
					iconSize: L.point(32, 40),
					iconAnchor: [15, 44],
					id: 'routel' + guid.replace('.', '')
				}
			});

			starl = new L.Marker.SVGMarker([lat, lng], {
				title: name + "l",
				iconOptions: {
					className: 'route',
					html: `<svg version="1.0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700.000000 627.000000" preserveAspectRatio="xMidYMid meet">
<g transform="translate(0.000000,627.000000) scale(0.100000,-0.100000)" fill="#000000" fill-opacity="0.7" stroke="none">
<path d="M3405 5459 c-27 -5 -61 -15 -75 -21 -64 -31 -190 -131 -190 -152 0 -6 -10 -20 -22 -31 -23 -20 -36 -41 -80 -126 -13 -24 -28 -49 -34 -56 -6 -6 -23 -35 -38 -65 -28 -55 -48 -90 -56 -98 -6 -6 -31 -50  62 -111 -13 -24 -29 -50 -36 -58 -8 -8 -25 -38 -38 -67 -13 -29 -28 -55 -33 -58 -5 -4 -19 -27 -32 -54 -12 -26 -30 -56 -39 -67 -10 -11 -21 -31 -25 -45 -4 -14 -10 -27 -14 -30 -16 -13 -51 -71 -57 -94 -3 -14  12 -30 -20 -37 -7 -6 -25 -35 -38 -63 -14 -29 -32 -59 -41 -66 -8 -7 -15 -18 -15 -24 0 -6 -15 -34 -32 -61 -18 -28 -41 -66 -50 -85 -19 -37 -39 -71 -48 -80 -3 -3 -13 -21 -23 -40 -40 -77 -76 -142 -87 -155 -7  8 -26 -41 -42 -72 -16 -32 -33 -60 -36 -63 -7 -5 -38 -59 -68 -120 -10 -19 -20 -37 -23 -40 -9 -8 -28 -40 -57 -98 -15 -30 -32 -59 -38 -65 -6 -7 -21 -32 -34 -56 -31 -61 -56 -105 -62 -111 -8 -8 -29 -43 -46 -80  10 -19 -27 -48 -38 -65 -12 -16 -32 -52 -46 -80 -13 -27 -29 -57 -36 -65 -7 -8 -24 -37 -40 -65 -51 -93 -63 -114 -87 -152 -13 -21 -30 -53 -38 -71 -8 -17 -17 -32 -20 -32 -3 0 -20 -28 -38 -62 -18 -35 -50  92 -72 -128 -22 -36 -47 -81 -56 -100 -10 -19 -23 -41 -31 -49 -8 -8 -24 -37 -37 -66 -13 -29 -31 -58 -40 -65 -8 -7 -15 -18 -15 -24 0 -6 -15 -35 -34 -63 -19 -29 -38 -63 -42 -75 -4 -13 -20 -39 -35 -58 -16 -19  29 -38 -29 -43 0 -9 -24 -68 -41 -99 -5 -10 -9 -26 -9 -36 0 -10 -5 -23 -12 -30 -14 -14 -16 -203 -1 -234 6 -13 18 -39 26 -58 9 -19 29 -48 46 -64 17 -17 31 -35 31 -40 0 -6 9 -16 19 -21 11 -6 36 -19 58  29 21 -11 40 -22 43 -25 3 -4 21 -13 40 -21 30 -13 181 -15 1100 -18 658 -1 1068 -6 1074 -12 6 -6 14 -6 21 0 7 6 423 11 1086 12 794 2 1079 6 1094 15 11 6 45 23 75 37 56 26 155 118 178 166 7 14 17 50 23 80 5  0 13 68 16 83 3 16 1 38 -5 50 -6 12 -13 44 -16 72 -4 27 -11 54 -16 59 -6 6 -10 17 -10 26 0 18 -52 124 -73 149 -8 9 -21 32 -31 51 -18 39 -38 72 -47 80 -3 3 -13 21 -23 40 -23 46 -78 144 -91 161 -6 8 -17  8 -25 44 -8 17 -24 44 -36 60 -11 17 -28 46 -38 65 -17 37 -38 72 -46 80 -6 6 -41 69 -66 120 -10 19 -20 37 -23 40 -9 8 -28 41 -48 80 -15 31 -52 94 -90 156 -7 10 -20 35 -30 54 -9 19 -19 37 -22 40 -9 8 -28 41  58 100 -15 30 -30 57 -34 60 -6 5 -35 55 -75 130 -11 19 -21 37 -24 40 -10 10 -31 46 -57 100 -15 30 -33 61 -41 69 -8 8 -24 37 -37 66 -13 29 -31 58 -40 65 -8 7 -15 18 -15 24 0 6 -16 34 -35 63 -19 28 -37  3 -41 77 -3 14 -10 26 -14 26 -5 0 -23 29 -41 65 -17 36 -38 70 -45 76 -8 6 -14 16 -14 21 0 5 -16 34 -35 64 -19 30 -35 57 -35 59 0 3 -12 24 -27 48 -15 23 -37 62 -50 87 -24 47 -44 81 -53 90 -3 3 -13 21 -22  0 -10 19 -24 44 -30 55 -35 55 -76 124 -91 155 -19 38 -39 72 -47 80 -6 6 -41 69 -66 120 -10 19 -20 37 -23 40 -9 8 -29 41 -47 80 -10 19 -23 42 -30 50 -13 15 -57 94 -90 160 -10 19 -20 37 -23 40 -9 7 -28 41  48 80 -9 19 -27 49 -40 66 -13 17 -23 35 -23 39 0 5 -12 21 -26 36 -15 15 -32 38 -38 50 -12 26 -114 108 -133 109 -7 0 -13 3 -13 8 0 4 -12 12 -27 19 -62 25 -150 34 -218 22z"></path></g></svg>`,

					iconSize: L.point(50, 58),
					iconAnchor: [25, 52],
					id: 'routel' + guid.replace('.', '')
				}
			});

		}

		if (!star)
			return;

		window.registerMarkerForOMS(star);
		star.on('spiderfiedclick', function () {
			// don't try to render fake portals
			if (guid.indexOf('.') > -1) {
				renderPortalDetails(guid);
			}
		});

		if (type === 'route') {
			routeLayers[guid + "l"] = starl;
			starl.addTo(routeLayerGroup);
			routeLayers[guid] = star;
			star.addTo(routeLayerGroup);
		}
	};

	thisPlugin.addAllMarkers = function() {
		for (let pid in routePortals) {
			const item = routePortals[pid];
			const lat = item.lat;
			const lng = item.lng;
			const guid = item.guid;
			const name = item.name;
			if (guid != null) {
				thisPlugin.addStar(guid, lat, lng, name, "route");
			}
		}
	};

	thisPlugin.resetCurrentRoute = function(confirmReset=true) {
		if (confirmReset) {
			if (confirm('Current Route will be deleted. Are you sure?', '') == false) {
				return;
			}
		}
		for (let pid in routeLayers) {
			try {
				const starInLayer = routeLayers[pid];
				routeLayerGroup.removeLayer(starInLayer);
				delete routeLayers[pid];
			}
			catch(err) {
				console.log(err);
				console.log(pid);
			}
		}
		routePortals = {};
		thisPlugin.saveRoutes();
	};

	thisPlugin.saveCurrentRoute = function() {
		const today  = new Date();
		const routeName = prompt("Please provide a name for this route", "New Route " + today.toLocaleString());
		const routeId = uuidv4();
		const routeToSave = {
			id: routeId,
			name: routeName,
			portals: routePortals
		}
		savedRoutes[routeId] = routeToSave;
		thisPlugin.saveRoutes();
	};

	function uuidv4() {
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
			const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
			return v.toString(16);
		});
	}

	thisPlugin.LoadManageRoute = function() {
		let html = '<div class="routeManagerDiv">';

		if (Object.keys(savedRoutes).length > 0) {
			html += '<div class="routeList" id="routeList">'
			Object.keys(savedRoutes).forEach(function (rid){
				html += thisPlugin.htmlConfig(rid);
			});
		} else {
			html += '<p>No saved Routes.</p>';
		}

		html += '</div><div><button class="importone" onclick="window.plugin.DronePathTravelPlanner.importOneRoute()">Import route</button><p></div>';

		dialog({
			title: 'Load/Manage Saved Routes',
			html: '<div id="routeManager">'+html+'</div>',
			dialogClass: 'ui-dialog-routemanager-main',
			minWidth: 400,
		});
	}

	thisPlugin.htmlConfig = function(ID){
		const name = savedRoutes[ID].name;
		let html = '';
		html += '<div class="routeList" data-layer="'+ID+'" id="rdelete'+ID+'">';
		html += '<a class="btn delete" onclick="window.plugin.DronePathTravelPlanner.deleteRoute(\''+ID+'\');return false;" title="Delete this route.">X</a>';
		html += '<a class="btn action" onclick="window.plugin.DronePathTravelPlanner.loadRoute(\''+ID+'\');return false;" title="Load this route.">'+ name +'</a>';
		html += '<a class="btn exportone" onclick="window.plugin.DronePathTravelPlanner.exportOneRoute(\''+ID+'\');return false;" title="Exports this route to a JSON file.">Export</a>';
		html += '</div>';
		return html;
	}

	thisPlugin.deleteRoute = function(guid) {
		if (confirm('Are you sure you want to delete this route?', '')) {
			delete savedRoutes[guid];
			const rElem = document.getElementById('rdelete'+guid);
			rElem.parentNode.removeChild(rElem);
			thisPlugin.saveRoutes();
		}
	};

	thisPlugin.loadRoute = function(guid) {
		if (Object.keys(routePortals).length > 0) {
			if (!confirm('Loading this route will overwrite the currently displayed route, if it is not saved it will be lost. Are you sure?', '')) {
				return false;
			}
		}
		thisPlugin.resetCurrentRoute(false);
		routePortals = savedRoutes[guid].portals;
		thisPlugin.addAllMarkers();
		thisPlugin.saveRoutes();
	};

	thisPlugin.exportOneRoute = function(guid) {
		const routeName = savedRoutes[guid].name;
		thisPlugin.saveToFile(savedRoutes[guid], routeName + '-export.json');
	};

	thisPlugin.saveToFile = function(text, filename) {
		if (typeof text != 'string') {
			text = JSON.stringify(text);
		}

		if (typeof window.saveFile != 'undefined') {
			window.saveFile(text, filename, 'application/json');
			return;
		}
	};

	thisPlugin.importOneRoute = function() {
		thisPlugin.readFromFile(function (content) {
			const route = JSON.parse(content);
			if ("id" in route &&
			    "name" in route &&
				"portals" in route) {

				let valid = true;
				Object.keys(route.portals).forEach(function (key){
					const portal = route.portals[key];
					if (!("guid" in portal &&
						  "lat" in portal &&
						  "lng" in portal &&
						  "name" in portal)) {
						valid = false;
						return;
					}
				});
				if (!valid) {
					return alert("Invalid route file.");
				}

				const rid = uuidv4();
				savedRoutes[rid] = {
					id: rid,
					name: route.name,
					portals: route.portals
				}
				thisPlugin.saveRoutes();
				const rld = document.getElementById("routeList");
				const newRouteDiv = thisPlugin.htmlConfig(rid);
				rld.insertAdjacentHTML('beforeend', newRouteDiv);
			} else {
				return alert("Invalid route file.");
			}
		});
	};

	thisPlugin.readFromFile = function(callback) {
		if (typeof L.FileListLoader != 'undefined') {
			L.FileListLoader.loadFiles({accept: 'application/json'})
				.on('load',function (e) {
					callback(e.reader.result);
				});
			return;
		}
	};

	function showSettingsDialog() {
		const html =
					`<p><label for="colorCircleColor">Radius Circle Color</label><br><input type="color" id="colorCircleColor" /></p>
					 <p><label for="textCircleWidth">Radius Circle Thickness</label><br><input type="text" id="textCircleWidth" /></p>
					 <p><label for="colorGridColor">Grid Color</label><br><input type="color" id="colorGridColor" /></p>
					 <p><label for="textGridWidth">Grid Line Thickness</label><br><input type="text" id="textGridWidth" /></p>
					 <p><label for="colorHighlight">Portal Highlight Color</label><br><input type="color" id="colorHighlight" /></p>
					 <p><label for="cbKeyRange">Display theoretical key range</label><br><input type="checkbox" id="cbKeyRange" /></p>
					 <p><label for="cbShowOneWay">Display one-way jumps</label><br><input type="checkbox" id="cbShowOneWay" /></p>
					 <label for="selectCalculationType">Calculation Method</label><br>
					 <select id="selectCalculationType">
						 <option value="500/16">500m / L16 cells</option>
						 <option value="570/17">570m / L17 cells</option>
					 </select>
					 <p>
					 Please note that neither of these methods are completely accurate. More investigation into the specifics of which portals will be in range is still needed.
					 </p>
					 <a onclick="window.resetSettings();return false;" title="Restores settings to default state">Reset to Defaults</a>
					`;

		const width = Math.min(screen.availWidth, 420);
		const container = dialog({
			id: "settings",
			width: width + "px",
			html: html,
			title: "Drone Path Planner Settings",
		});

		const div = container[0];

		const colorCircleColorPicker = div.querySelector("#colorCircleColor");
		colorCircleColorPicker.value = settings.circleColor;
		colorCircleColorPicker.addEventListener("change", (e) => {
			settings.circleColor = colorCircleColorPicker.value;
			saveSettings();
		});

		const textCircleWidthStr = div.querySelector("#textCircleWidth");
		textCircleWidthStr.value = settings.circleWidth;
		textCircleWidthStr.addEventListener("change", (e) => {
			settings.circleWidth = textCircleWidthStr.value;
			saveSettings();
		});

		const colorGridColorPicker = div.querySelector("#colorGridColor");
		colorGridColorPicker.value = settings.gridColor;
		colorGridColorPicker.addEventListener("change", (e) => {
			settings.gridColor = colorGridColorPicker.value;
			saveSettings();
		});

		const textGridWidthStr = div.querySelector("#textGridWidth");
		textGridWidthStr.value = settings.gridWidth;
		textGridWidthStr.addEventListener("change", (e) => {
			settings.gridWidth = textGridWidthStr.value;
			saveSettings();
		});

		const colorHighlightPicker = div.querySelector("#colorHighlight");
		colorHighlightPicker.value = settings.portalHighlight;
		colorHighlightPicker.addEventListener("change", (e) => {
			settings.portalHighlight = colorHighlightPicker.value;
			saveSettings();
		});

		const selectCalculationTypeOption = div.querySelector("#selectCalculationType");
		selectCalculationTypeOption.value = settings.calculationMethod;
		selectCalculationTypeOption.addEventListener("change", (e) => {
			settings.calculationMethod = selectCalculationTypeOption.value;
			saveSettings();
		});

		const keyRangeCB = div.querySelector("#cbKeyRange");
		keyRangeCB.checked = settings.keyRange;
		keyRangeCB.addEventListener("change", (e) => {
			settings.keyRange = keyRangeCB.checked;
			saveSettings();
		});

		const showOneWayCB = div.querySelector("#cbShowOneWay");
		showOneWayCB.checked = settings.showOneWay;
		showOneWayCB.addEventListener("change", (e) => {
			settings.showOneWay = showOneWayCB.checked;
			saveSettings();
		});
	};

	function showActionsDialog() {
		const content = `<div id="droneActionsBox">
			<a onclick="window.plugin.DronePathTravelPlanner.resetCurrentRoute();return false;" title="Deletes all current route markers">Reset Current Route</a>
			<a onclick="window.plugin.DronePathTravelPlanner.saveCurrentRoute();return false;" title="Save current route">Save Current Route</a>
			<a onclick="window.plugin.DronePathTravelPlanner.LoadManageRoute();return false;" title="Load/Manage saved routes">Load/Manage Route</a>
			</div>`;

		const container = dialog({
			html: content,
			title: 'Drone Grid Actions'
		});
	};


	window.drawDroneRange = function (guid) {
		portalDroneIndicator = null;
		portalDroneIndicatorKey = null;
		dGridLayerGroup.clearLayers();

		if (guid) {
			if (guid.selectedPortalGuid) {
				lastPortalGuid = guid;

				p = window.portals[guid.selectedPortalGuid];
				const calcMethod = calculationMethods[settings.calculationMethod];
				if (p) {
					const coord = new LatLng(p._latlng.lat, p._latlng.lng);
					portalDroneIndicator = L.circle(coord, calcMethod["radius"],
						{ fill: false, color: settings.circleColor, weight: settings.circleWidth, interactive: false }
					)
					dGridLayerGroup.addLayer(portalDroneIndicator);
					if (settings.keyRange) {
						portalDroneIndicatorKey = L.circle(coord, THEORETICAL_KEY_RANGE,
						{ fill: false, color: settings.circleColor, weight: settings.circleWidth, interactive: false }
					)
						dGridLayerGroup.addLayer(portalDroneIndicatorKey);
					}
				}
				updateMapGrid(calcMethod["gridSize"]);
			} else {
				if (droneLayer.hasLayer(dGridLayerGroup)) {
					droneLayer.removeLayer(dGridLayerGroup);
				}
			}
		}
	};

	setup.info = plugin_info; //add the script info data to the function as a property
	// if IITC has already booted, immediately run the 'setup' function
	if (window.iitcLoaded) {
		setup();
		} else {
			if (!window.bootPlugins) {
				window.bootPlugins = [];
			}
		window.bootPlugins.push(setup);
	}


	function updateMapGrid(gridSize) {
		if (!portalDroneIndicator) {
			return;
		}

		const zoom = map.getZoom();

		if (zoom > 8) {
			const cellsToDraw = determineCellGridInRange(portalDroneIndicator.getLatLng(), gridSize);
			drawnCells = cellsToDraw;
			Object.keys(cellsToDraw).forEach(function (key){
				dGridLayerGroup.addLayer(drawCell(cellsToDraw[key], settings.gridColor, settings.gridWidth));
			});
			highlightPortalsInRange();
			if (!droneLayer.hasLayer(dGridLayerGroup)) {
				droneLayer.addLayer(dGridLayerGroup);
			}
		}
	}

	function determineCellGridInRange(centerPoint, gridLevel) {
		const seenCells = {};
		const cellsToDraw = [];
		const cellsInRange = {};
		const cell = S2.S2Cell.FromLatLng(getLatLngPoint(centerPoint), gridLevel);
		cellsToDraw.push(cell);
		seenCells[cell.toString()] = true;

		let curCell;
		while (cellsToDraw.length > 0) {
			curCell = cellsToDraw.pop();
			const neighbors = curCell.getNeighbors();

			for (let n = 0; n < neighbors.length; n++) {
				const nStr = neighbors[n].toString();
				if (isCellinRange(neighbors[n], centerPoint)) {
					if (!seenCells[nStr]) {
						seenCells[nStr] = true;
						cellsToDraw.push(neighbors[n]);
					}
				}
			}

			cellsInRange[curCell.toString()] = curCell;
		}
		return cellsInRange;
	}

	function drawCell(cell, color, weight, opacity = 90) {
		const corners = cell.getCornerLatLngs();

		// NOTE: we only draw two of the edges. as we draw all cells on screen, the other two edges will either be drawn
		// from the other cell, or be off screen so we don't care
		const region = L.polyline([corners[0], corners[1], corners[2], corners[3], corners[0]], {fill: false, color: color, opacity: opacity, weight: weight, clickable: false, interactive: false});

		return region;
	}

	function highlightPortalsInRange() {
		const scale = portalMarkerScale();
		//	 portal level		 0	1  2  3  4	5  6  7  8
		const LEVEL_TO_WEIGHT = [2, 2, 2, 2, 2, 3, 3, 4, 4];
		const LEVEL_TO_RADIUS = [7, 7, 7, 7, 8, 8, 9,10,11];
		let portalsInRange = [];

		Object.keys(window.portals).forEach(function (key){
			const portal = window.portals[key];
			const portalLatLng = L.latLng(portal._latlng.lat, portal._latlng.lng);
			const portalCell = S2.S2Cell.FromLatLng(getLatLngPoint(portalLatLng), calculationMethods[settings.calculationMethod]["gridSize"]);
			if (portalCell.toString() in drawnCells) {
				portalsInRange.push(portal);
				const level = Math.floor(portal["options"]["level"]||0);
				const lvlWeight = LEVEL_TO_WEIGHT[level] * Math.sqrt(scale) + 1;
				const lvlRadius = LEVEL_TO_RADIUS[level] * scale + 2;
				dGridLayerGroup.addLayer(L.circleMarker(portalLatLng, { radius: lvlRadius, fill: true, color: settings.portalHighlight, weight: lvlWeight, interactive: false, clickable: false }
				));
			}
		});
		drawnCells = {};
		if (settings.showOneWay) {
			highlightOneWayJumps(portalsInRange);
		}
	}

	function highlightOneWayJumps(portalsInRange) {
		const circlePoint = portalDroneIndicator.getLatLng();
		const centerPointCell = S2.S2Cell.FromLatLng(getLatLngPoint(circlePoint), calculationMethods[settings.calculationMethod]["gridSize"]);
		const searchLatLng = L.latLng(47.481489,-122.196868);

		portalsInRange.forEach(portal => {
			const portalPoint = new LatLng(portal._latlng.lat, portal._latlng.lng);
			if (haversine(portalPoint.lat, portalPoint.lng, circlePoint.lat, circlePoint.lng) > calculationMethods[settings.calculationMethod]["radius"]) {
				const cellRange = determineCellGridInRange(portalPoint, calculationMethods[settings.calculationMethod]["gridSize"]);
				if (!(centerPointCell.toString() in cellRange)) {
					dGridLayerGroup.addLayer(L.circleMarker(portalPoint, { radius: 15, fill: true, color: 'red', weight: 5, interactive: false, clickable: false }));
				}
			}
		});
	}

	function portalMarkerScale() {
		const zoom = map.getZoom();
		if (L.Browser.mobile)
			return zoom >= 16 ? 1.5 : zoom >= 14 ? 1.2 : zoom >= 11 ? 1.0 : zoom >= 8 ? 0.65 : 0.5;
		else
			return zoom >= 14 ? 1 : zoom >= 11 ? 0.8 : zoom >= 8 ? 0.65 : 0.5;
	}

	function fillCell(cell, color, opacity) {
		// corner points
		const corners = cell.getCornerLatLngs();

		const region = L.polygon(corners, {color: color, fillOpacity: opacity, weight: 0, clickable: false, interactive: false});

		return region;
	}

	function isCellinRange(cell, centerLatLng) {
		const corners = cell.getCornerLatLngs();
		for (let i = 0; i < corners.length; i++) {
			if (haversine(corners[i].lat, corners[i].lng, centerLatLng.lat, centerLatLng.lng) < calculationMethods[settings.calculationMethod]["radius"]) {
				return true;
			}
		}
		const midpoints = getCellFaceMidpointLatLngs(corners);
		for (let i = 0; i < midpoints.length; i++) {
			if (haversine(midpoints[i].lat, midpoints[i].lng, centerLatLng.lat, centerLatLng.lng) < calculationMethods[settings.calculationMethod]["radius"]) {
				return true;
			}
		}
		const quarterpoints = getCellFaceQuarterpointLatLngs(corners);
		for (let i = 0; i < quarterpoints.length; i++) {
			if (haversine(quarterpoints[i].lat, quarterpoints[i].lng, centerLatLng.lat, centerLatLng.lng) < calculationMethods[settings.calculationMethod]["radius"]) {
				return true;
			}
		}
		return false;
	};

	function haversine(lat1, lon1, lat2, lon2) {
		const R = 6371e3; // metres
		const φ1 = lat1 * Math.PI/180; // φ, λ in radians
		const φ2 = lat2 * Math.PI/180;
		const Δφ = (lat2-lat1) * Math.PI/180;
		const Δλ = (lon2-lon1) * Math.PI/180;

		const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
					Math.cos(φ1) * Math.cos(φ2) *
					Math.sin(Δλ/2) * Math.sin(Δλ/2);
		const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

		return R * c; // in metres
	}

	function getLatLngPoint(data) {
		const result = {
			lat: typeof data.lat == 'function' ? data.lat() : data.lat,
			lng: typeof data.lng == 'function' ? data.lng() : data.lng
		};

		return result;
	}

	/* @class LatLng
	 * @aka L.LatLng
	 *
	 * Represents a geographical point with a certain latitude and longitude.
	 *
	 * @example
	 *
	 * ```
	 * var latlng = L.latLng(50.5, 30.5);
	 * ```
	 *
	 * All Leaflet methods that accept LatLng objects also accept them in a simple Array form and simple object form (unless noted otherwise), so these lines are equivalent:
	 *
	 * ```
	 * map.panTo([50, 30]);
	 * map.panTo({lon: 30, lat: 50});
	 * map.panTo({lat: 50, lng: 30});
	 * map.panTo(L.latLng(50, 30));
	 * ```
	 *
	 * Note that `LatLng` does not inherit from Leaflet's `Class` object,
	 * which means new classes can't inherit from it, and new methods
	 * can't be added to it with the `include` function.
	 */

	function LatLng(lat, lng, alt) {
		if (isNaN(lat) || isNaN(lng)) {
			throw new Error('Invalid LatLng object: (' + lat + ', ' + lng + ')');
		}

		// @property lat: Number
		// Latitude in degrees
		this.lat = +lat;

		// @property lng: Number
		// Longitude in degrees
		this.lng = +lng;

		// @property alt: Number
		// Altitude in meters (optional)
		if (alt !== undefined) {
			this.alt = +alt;
		}
	}

	LatLng.prototype = {
		// @method equals(otherLatLng: LatLng, maxMargin?: Number): Boolean
		// Returns `true` if the given `LatLng` point is at the same position (within a small margin of error). The margin of error can be overridden by setting `maxMargin` to a small number.
		equals: function (obj, maxMargin) {
			if (!obj) { return false; }

			obj = toLatLng(obj);

			var margin = Math.max(
					Math.abs(this.lat - obj.lat),
					Math.abs(this.lng - obj.lng));

			return margin <= (maxMargin === undefined ? 1.0E-9 : maxMargin);
		},

		// @method toString(): String
		// Returns a string representation of the point (for debugging purposes).
		toString: function (precision) {
			return 'LatLng(' +
					formatNum(this.lat, precision) + ', ' +
					formatNum(this.lng, precision) + ')';
		},

		// @method distanceTo(otherLatLng: LatLng): Number
		// Returns the distance (in meters) to the given `LatLng` calculated using the [Spherical Law of Cosines](https://en.wikipedia.org/wiki/Spherical_law_of_cosines).
		distanceTo: function (other) {
			return Earth.distance(this, toLatLng(other));
		},

		// @method wrap(): LatLng
		// Returns a new `LatLng` object with the longitude wrapped so it's always between -180 and +180 degrees.
		wrap: function () {
			return Earth.wrapLatLng(this);
		},

		// @method toBounds(sizeInMeters: Number): LatLngBounds
		// Returns a new `LatLngBounds` object in which each boundary is `sizeInMeters/2` meters apart from the `LatLng`.
		toBounds: function (sizeInMeters) {
			var latAccuracy = 180 * sizeInMeters / 40075017,
				lngAccuracy = latAccuracy / Math.cos((Math.PI / 180) * this.lat);

			return toLatLngBounds(
					[this.lat - latAccuracy, this.lng - lngAccuracy],
					[this.lat + latAccuracy, this.lng + lngAccuracy]);
		},

		clone: function () {
			return new LatLng(this.lat, this.lng, this.alt);
		}
	};

	thisPlugin.setupCSS = function () {
		$('<style>').prop('type', 'text/css').html(`
		.droneRoute span {
			display:inline-block;
			float:left;
			margin:3px 1px 0 4px;
			width:16px;
			height:15px;
			overflow:hidden;
			background-repeat:no-repeat;
		}
		.droneRoute span, .droneRoute:focus span {
			background-position:right top;
		}
		.droneRoute.favorite span, .droneRoute.favorite:focus span{
			background-position:left top;
		}

		.droneRoute span {
			background-image:url(data:image/png;base64,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);
		}

		.DroneButtons {
			color: #fff;
			padding: 3px;
		}

		.DroneButtons span {
			float: none;
		}

		#droneActionsBox a{
			display:block;
			color:#ffce00;
			border:1px solid #ffce00;
			padding:3px 0;
			margin:10px auto;
			width:80%;
			text-align:center;
			background:rgba(8,48,78,.9);
		}
		#droneActionsBox a.disabled,
		#droneActionsBox a.disabled:hover{
			color:#666;
			border-color:#666;
			text-decoration:none;
		}

		#droneActionsBox{
			text-align:center;
		}

		#routeManager .routeManagerDiv{
			margin-top:12px;
		}

		#routeManager .routeManagerDiv .routeList{
			margin:7px 0 0;
		}

		#routeManager a.btn{
			display:inline-block;
			color:#ffce00;
			border:1px solid #ffce00;
			padding:3px 0;
			margin:10px 0 10px 5px;
			width:70%;
			text-align:center;
			background:rgba(8,48,78,.9);
		}

		#routeManager a.btn.delete{
			width: 7%;
			color: red;
		}

		#routeManager a.btn.exportone{
			width: 14%;
			color: white;
		}

		#routeManager button.importone{
			width:50%
			padding: 18px 36px;
			text-align: center;
			text-decoration: none;
			display: block;
			font-weight: bold;
			font-size: 14px;
			margin: 4px 2px;
			cursor: pointer;
			transition-duration: 0.4s;
		}

		#routeManager button.importone:hover{
			color:rgba(8,48,78,.9);
			background:#ffce00;
		}

		.ui-dialog-routemanager-config dl{
			margin-left:10px;
		}

		.ui-dialog-routemanager-config dl dt{
			color:#ffce00;
			margin:9px 0 3px;
		}
		.ui-dialog-routemanager-config dl dd{
			margin:2px 0 0 17px;
			list-style:disc;
			display:list-item;
		}

		#routeManager .red, .ui-dialog-routemanager-config .red{
			border-color:#f44 !important;
			color:#f44 !important;
		}

		#routeManager label, #routeManager label input{
			text-align:center;
			cursor:pointer;
		}

		#routeManager label{
			width:29%;
			display:inline-block;
		}
		`).appendTo('head');
	}
}


(function () {
	const plugin_info = {};
	if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
		plugin_info.script = {
			version: GM_info.script.version,
			name: GM_info.script.name,
			description: GM_info.script.description
		};
	}
	// Greasemonkey. It will be quite hard to debug
	if (typeof unsafeWindow != 'undefined' || typeof GM_info == 'undefined' || GM_info.scriptHandler != 'Tampermonkey') {
	// inject code into site context
		const script = document.createElement('script');
		script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(plugin_info) + ');'));
		(document.body || document.head || document.documentElement).appendChild(script);
	} else {
		// Tampermonkey, run code directly
		wrapper(plugin_info);
	}
})();
