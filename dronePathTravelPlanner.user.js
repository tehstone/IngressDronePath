// ==UserScript==
// @id dronePathTravelPlanner
// @name IITC Plugin: Drone Travel Path Planner
// @category Tweaks
// @version 0.8.1
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

	// Use own namespace for plugin
	window.plugin.DronePathTravelPlanner = function () {};

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

	window.portalDroneIndicator	= null;
	window.portalDroneIndicatorKey = null;
	droneLayer = null;
	dGridLayerGroup = null;
	let lastPortalGuid = null;

	let drawnCells = {};

	map = window.map;
	calculationMethods = 
	{
		"500/16": {"radius": 500, "gridSize": 16},
		"570/17": {"radius": 570, "gridSize": 17}
	}

	const d2r = Math.PI / 180.0;
	const r2d = 180.0 / Math.PI;

	S2 = {};

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

	// The entry point for this plugin.
	function setup() {
		loadSettings();

		window.addHook(
			"portalSelected",
			window.drawDroneRange
		);

		droneLayer = L.layerGroup();
		window.addLayerGroup('Drone Grid', droneLayer, true);
		dGridLayerGroup = L.layerGroup();

		const toolbox = document.getElementById("toolbox");

		const buttonDrone = document.createElement("a");
		buttonDrone.textContent = "Drone Grid Settings";
		buttonDrone.title = "Configuration for Drone Path Plugin";
		buttonDrone.addEventListener("click", showSettingsDialog);
		toolbox.appendChild(buttonDrone);
	}

	function showSettingsDialog() {
		const html =
					`<p><label for="colorCircleColor">Radius Circle Color</label><br><input type="color" id="colorCircleColor" /></p>
					 <p><label for="textCircleWidth">Radius Circle Thickness</label><br><input type="text" id="textCircleWidth" /></p>
					 <p><label for="colorGridColor">Grid Color</label><br><input type="color" id="colorGridColor" /></p>
					 <p><label for="textGridWidth">Grid Line Thickness</label><br><input type="text" id="textGridWidth" /></p>
					 <p><label for="colorHighlight">Portal Highlight Color</label><br><input type="color" id="colorHighlight" /></p>
					 <p><label for="cbKeyRange">Display theoretical key range</label><br><input type="checkbox" id="cbKeyRange" /></p>
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
						portalDroneIndicatorKey = L.circle(coord, calcMethod["radius"] * 2,
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
			drawCellGrid(zoom, gridSize, settings.gridColor, settings.gridWidth);
			if (!droneLayer.hasLayer(dGridLayerGroup)) {
				droneLayer.addLayer(dGridLayerGroup);
			}
		}

	}

	function drawCellGrid(zoom, gridLevel, col, thickness = 1) {
		const seenCells = {};
		const cellsToDraw = [];
		const latLng = portalDroneIndicator.getLatLng(); 
		const cell = S2.S2Cell.FromLatLng(getLatLngPoint(latLng), gridLevel);
		cellsToDraw.push(cell);
		seenCells[cell.toString()] = true;

		let curCell;
		while (cellsToDraw.length > 0) {
			curCell = cellsToDraw.pop();
			const neighbors = curCell.getNeighbors();

			for (let n = 0; n < neighbors.length; n++) {
				const nStr = neighbors[n].toString();
				if (isCellinRange(neighbors[n])) {
					if (!seenCells[nStr]) {
						seenCells[nStr] = true;
						cellsToDraw.push(neighbors[n]);
					}
				}
			}

			drawnCells[curCell.toString()] = curCell;
			dGridLayerGroup.addLayer(drawCell(curCell, col, thickness));
		}

		highlightPortalsInRange();
	}

	function drawCell(cell, color, weight, opacity = 90) {
		// corner points
		const corners = cell.getCornerLatLngs();

		// the level 6 cells have noticible errors with non-geodesic lines - and the larger level 4 cells are worse
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

		Object.keys(window.portals).forEach(function (key){
			const portal = window.portals[key];
			const portalLatLng = L.latLng(portal._latlng.lat, portal._latlng.lng);
			const portalCell = S2.S2Cell.FromLatLng(getLatLngPoint(portalLatLng), calculationMethods[settings.calculationMethod]["gridSize"]);
			if (portalCell.toString() in drawnCells) {
				const level = Math.floor(portal["options"]["level"]||0);
				const lvlWeight = LEVEL_TO_WEIGHT[level] * Math.sqrt(scale) + 1;
				const lvlRadius = LEVEL_TO_RADIUS[level] * scale + 2;
				dGridLayerGroup.addLayer(L.circleMarker(portalLatLng, { radius: lvlRadius, fill: true, color: settings.portalHighlight, weight: lvlWeight, interactive: false }
				));

			}
		});
		drawnCells = {};
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

	function isCellinRange(cell) {
		const circlePoints = portalDroneIndicator.getLatLng(); 
		const corners = cell.getCornerLatLngs();
		for (let i = 0; i < corners.length; i++) {
			if (haversine(corners[i].lat, corners[i].lng, circlePoints.lat, circlePoints.lng) < calculationMethods[settings.calculationMethod]["radius"]) {
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

	const defaultSettings = {
		circleColor: "#800080",
		circleWidth: 2,
		gridColor: "#00FF00",
		gridWidth: 2,
		calculationMethod: "500/16",
		portalHighlight: "#f228ef",
		keyRange: false,
	};

	let settings = defaultSettings;

	function saveSettings() {
		createThrottledTimer("saveSettings", function () {
			localStorage[KEY_SETTINGS] = JSON.stringify(settings);
		});
		drawDroneRange(lastPortalGuid);
	}

	function loadSettings() {
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
			settings.keyRange =false
		}
	}

	window.resetSettings = function() {
		settings = JSON.parse(JSON.stringify(defaultSettings));
		showSettingsDialog();
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
