
$(document).ready(function () {
    $('.your-local-life-title').fadeIn(1000, function() {
        $('.result-bar').fadeIn(1000, function() {
            $('.where-para').fadeIn(1000, function() {
                // wait for input
            })
        });
    });
});

var longitude;
var latitude;
var radius = 3;
var map = null;
var speciesPaused = false;
var speciesRunId = 0;

$(document).on('click', '#pauseResume', function() {
    speciesPaused = !speciesPaused;
    updatePauseResumeButton();
});

function updatePauseResumeButton() {
    var $btn = $('#pauseResume');
    if (!$btn.length) return;
    $btn.text(speciesPaused ? 'Resume' : 'Pause');
    $btn.attr('aria-pressed', speciesPaused ? 'true' : 'false');
}

$(document).on('submit', '#searchForm', function(e) {
    e.preventDefault();

    var inputVal = $('#address').val().trim();

    // Check if the input looks like coordinates (contains a comma with numbers either side)
    var coordPattern = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/;
    if (coordPattern.test(inputVal)) {
        var parts = inputVal.split(',');
        latitude  = parts[0].trim();
        longitude = parts[1].trim();
        doSearch();
    } else if (inputVal.length > 0) {
        // Geocode the address using the Nominatim API
        searchPending('Geocoding your location...');
        $.get('https://nominatim.openstreetmap.org/search', {
            q: inputVal,
            format: 'json',
            limit: 1,
            countrycodes: 'au'
        })
        .done(function(results) {
            if (!results || results.length === 0) {
                showError('Could not find that location. Please try a more specific address or use GPS coordinates.');
                return;
            }
            latitude  = results[0].lat;
            longitude = results[0].lon;
            doSearch();
        })
        .fail(function() {
            showError('Geocoding failed. Please check your connection or try entering GPS coordinates directly.');
        });
    } else {
        // Empty input: fall back to Canberra
        latitude  = '-35.2748';
        longitude = '149.1142';
        doSearch();
    }
});

function doSearch() {
    searchPending('Retrieving your results...');

    var biocacheUrl = 'https://biocache.ala.org.au/ws';
    $.get(biocacheUrl + '/occurrences/search?q=*:*&radius=' + radius + '&lon=' + longitude + '&lat=' + latitude + '&fl=id,image_url&fq=images:*&pageSize=100&facet=true&facets=point-0.0001,vernacularName&flimit=-1')
    .done(function(data) {
        if (!data.facetResults || data.facetResults.length < 2) {
            showError('No species data found for this location. Try a different area.');
            return;
        }
        var coordsText = formatCoords(latitude, longitude);
        var runId = speciesRunId;
        $('.begin-para').text('Here is what we found for (' + coordsText + ')...');
        reverseGeocode(latitude, longitude, runId);
        $('.begin-para').fadeIn(1000, function() {
            makeMap(data);
            showSpecies(data);
        });
    })
    .fail(function() {
        showError('Could not retrieve biodiversity data. Please check your connection and try again.');
    });
}

function formatCoords(lat, lon) {
    var latNum = parseFloat(lat);
    var lonNum = parseFloat(lon);
    if (!isFinite(latNum) || !isFinite(lonNum)) {
        return String(lat).trim() + ', ' + String(lon).trim();
    }
    return latNum.toFixed(4) + ', ' + lonNum.toFixed(4);
}

function bestPlaceNameFromNominatim(result) {
    if (!result) return null;
    if (result.name && String(result.name).trim().length) return String(result.name).trim();
    if (result.address) {
        var a = result.address;
        var locality = a.city || a.town || a.suburb || a.village || a.hamlet || a.municipality || a.county;
        var region = a.state || a.territory;
        if (locality && region) return locality + ', ' + region;
        if (locality) return locality;
        if (region) return region;
    }
    if (result.display_name) {
        var parts = String(result.display_name).split(',').map(function(p) { return p.trim(); }).filter(Boolean);
        if (parts.length >= 2) return parts[0] + ', ' + parts[1];
        if (parts.length === 1) return parts[0];
    }
    return null;
}

function reverseGeocode(lat, lon, runId) {
    // Best-effort: update the location line when we can resolve a place name
    $.get('https://nominatim.openstreetmap.org/reverse', {
        lat: lat,
        lon: lon,
        format: 'jsonv2',
        zoom: 10,
        addressdetails: 1,
        'accept-language': 'en'
    })
    .done(function(result) {
        if (runId !== speciesRunId) return;
        var place = bestPlaceNameFromNominatim(result);
        if (!place) return;
        var coordsText = formatCoords(latitude, longitude);
        $('.begin-para').text('Here is what we found for ' + place + ' (' + coordsText + ')...');
    })
    .fail(function() {
        // Reverse geocode failure is non-fatal; keep coordinates-only label
    });
}

function searchPending(message) {
    // Invalidate any previous species animation loop
    speciesRunId += 1;
    speciesPaused = false;
    updatePauseResumeButton();
    $('#pauseResume').hide();

    $('body').addClass('has-results');
    $('.where-para').hide();
    $('.result-bar').hide();
    $('.begin-para').text(message || 'Retrieving your results...');
    $('.result-bar').fadeIn(1000);
}

function showError(message) {
    $('body').removeClass('has-results');
    $('#pauseResume').hide();
    $('.begin-para').text(message);
    $('.result-bar').fadeIn(500);
    $('.where-para').fadeIn(500);
}

function waitWhilePaused(runId) {
    return new Promise((resolve) => {
        function tick() {
            if (runId !== speciesRunId) {
                resolve(false);
                return;
            }
            if (!speciesPaused) {
                resolve(true);
                return;
            }
            setTimeout(tick, 200);
        }
        tick();
    });
}

function showSpecies(data) {
    // Clear any previous results
    $('#localSpeciesPreview').empty();
    $('#localSpecies').empty();

    var runId = speciesRunId;
    speciesPaused = false;
    updatePauseResumeButton();
    $('#pauseResume').show();

    // Randomize species order (facet results are typically alphabetical)
    var speciesList = (data.facetResults && data.facetResults[1] && data.facetResults[1].fieldResult)
        ? data.facetResults[1].fieldResult.slice()
        : [];
    for (var s = speciesList.length - 1; s > 0; s--) {
        var j = Math.floor(Math.random() * (s + 1));
        var tmp = speciesList[s];
        speciesList[s] = speciesList[j];
        speciesList[j] = tmp;
    }

    (async () => {
        for (var i = 0; i < speciesList.length; i++) {
            await new Promise((resolve) => {
                setTimeout(() => {
                    if (runId !== speciesRunId) {
                        resolve(true);
                        return;
                    }

                    waitWhilePaused(runId).then(function(canContinue) {
                        if (!canContinue) {
                            resolve(true);
                            return;
                        }

                    let commonname = speciesList[i].label;
                    if (commonname === 'Not supplied') {
                        resolve(true);
                        return;
                    }

                    let speciesURL = 'https://bie.ala.org.au/species/' + encodeURIComponent(commonname);
                    $.get('https://bie.ala.org.au/ws/species/' + encodeURIComponent(commonname))
                    .done(function(speciesData) {
                        if (runId !== speciesRunId) return;
                        if (speciesData.imageIdentifier == null) return;

                        waitWhilePaused(runId).then(function(canContinue) {
                            if (!canContinue) return;
                            if (runId !== speciesRunId) return;

                            let imageURL = 'https://images.ala.org.au/image/proxyImageThumbnail?imageId=' + speciesData.imageIdentifier;
                            let guid = speciesData.taxonConcept.guid;
                            let cardHTML = '<div class="localSpeciesCard" onclick="showOnMap(\'' + guid + '\')">'
                                + '<div class="localSpeciesCardImage"><a href="' + speciesURL + '" target="_blank"><img src="' + imageURL + '" alt="' + $('<div>').text(commonname).html() + '" /></a></div>'
                                + '<div class="localSpeciesCardText"><a href="' + speciesURL + '" target="_blank">' + $('<div>').text(commonname).html() + '</a></div>'
                                + '</div>';

                            var $preview = $('#localSpeciesPreview');
                            var $grid = $('#localSpecies');
                            var $existing = $preview.find('.localSpeciesCard').first();
                            if ($existing.length) {
                                $existing.stop(true, true).detach().appendTo($grid).hide().fadeIn(300);
                            }

                            var $newCard = $(cardHTML);
                            $preview.empty().append($newCard);
                            $newCard.hide().fadeIn(600, function() {
                                if (runId !== speciesRunId) return;
                                showOnMap(guid);
                            });
                        });
                    })
                    .fail(function() {
                        // Species lookup failed silently — skip this species
                    })
                    .always(function() {
                        resolve(true);
                    });
                    });
                }, 2700);
            });
        }

        if (runId !== speciesRunId) return;

        // When the sequence finishes, move the last preview card into the grid
        var $finalCard = $('#localSpeciesPreview').find('.localSpeciesCard').first();
        if ($finalCard.length) {
            $finalCard.detach().appendTo('#localSpecies').hide().fadeIn(300);
            $('#localSpeciesPreview').empty();
        }

        $('#pauseResume').hide();
    })();
}

function makeMap(data) {
    // Clean up any existing map instance before creating a new one
    if (map !== null) {
        map.remove();
        map = null;
    }

    map = new maptalks.Map('map', {
        center: [longitude, latitude],
        zoom: 14,
        pitch: 40,
        dragPitch: true,
        dragRotate: true,
        dragRotatePitch: true,
        baseLayer: new maptalks.TileLayer('base', {
            urlTemplate: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            subdomains: ['a', 'b', 'c', 'd'],
            attribution: '&copy; <a href="http://osm.org">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/">CARTO</a>'
        })
    });

    addMarkers(data);
}

function makeGlowSymbol(coreColor, glowColor, opacity) {
    return [
        { 'markerType': 'ellipse', 'markerFill': '#fff',      'markerFillOpacity': 1,       'markerWidth': 3, 'markerHeight': 3, 'markerLineWidth': 0 },
        { 'markerType': 'ellipse', 'markerFill': coreColor,   'markerFillOpacity': 0.9,     'markerWidth': 3, 'markerHeight': 3, 'markerLineWidth': 0 },
        { 'markerType': 'ellipse', 'markerFill': glowColor,   'markerFillOpacity': 0.8,     'markerWidth': 3, 'markerHeight': 3, 'markerLineWidth': 0 },
        { 'markerType': 'ellipse', 'markerFill': glowColor,   'markerFillOpacity': 0.3,     'markerWidth': 4, 'markerHeight': 4, 'markerLineWidth': 0 },
        { 'markerType': 'ellipse', 'markerFill': glowColor,   'markerFillOpacity': 0.2,     'markerWidth': 5, 'markerHeight': 5, 'markerLineWidth': 0 }
    ];
}

function parsePoints(fieldResults) {
    var points = [];
    for (var i = 0; i < fieldResults.length; i++) {
        var parts = fieldResults[i].label.split(',');
        points.push([parseFloat(parts[1]), parseFloat(parts[0])]);
    }
    return points;
}

function addMarkers(data) {
    var points = parsePoints(data.facetResults[0].fieldResult);
    var multipoint = new maptalks.MultiPoint(points, {
        visible: true,
        editable: false,
        cursor: 'pointer',
        draggable: false,
        symbol: makeGlowSymbol('#1bc8ff', '#0096cd')
    });
    new maptalks.VectorLayer('vector', multipoint).addTo(map);
}

var vectorLayerOfSelected = null;
function showOnMap(lsid) {
    if (vectorLayerOfSelected !== null) {
        map.removeLayer(vectorLayerOfSelected);
        vectorLayerOfSelected = null;
    }

    $.get('https://biocache.ala.org.au/ws/occurrences/search?q=taxonConceptID:' + encodeURIComponent(lsid) + '&radius=' + radius + '&lon=' + longitude + '&lat=' + latitude + '&fl=id,image_url&fq=images:*&pageSize=100&facet=true&facets=point-0.0001,vernacularName&flimit=-1')
    .done(function(data) {
        if (!data.facetResults || !data.facetResults[0]) return;
        var points = parsePoints(data.facetResults[0].fieldResult);
        var multipointSelected = new maptalks.MultiPoint(points, {
            visible: true,
            editable: false,
            cursor: 'pointer',
            draggable: false,
            symbol: [
                { 'markerType': 'ellipse', 'markerFill': '#fff',     'markerFillOpacity': 1,   'markerWidth': 1, 'markerHeight': 1, 'markerLineWidth': 0 },
                { 'markerType': 'ellipse', 'markerFill': '#1bc8ff',  'markerFillOpacity': 0.9, 'markerWidth': 2, 'markerHeight': 2, 'markerLineWidth': 0 },
                { 'markerType': 'ellipse', 'markerFill': '#ff0000',  'markerFillOpacity': 0.8, 'markerWidth': 3, 'markerHeight': 3, 'markerLineWidth': 0 },
                { 'markerType': 'ellipse', 'markerFill': '#ff0000',  'markerFillOpacity': 0.7, 'markerWidth': 4, 'markerHeight': 4, 'markerLineWidth': 0 },
                { 'markerType': 'ellipse', 'markerFill': '#ff0000',  'markerFillOpacity': 0.6, 'markerWidth': 8, 'markerHeight': 8, 'markerLineWidth': 0 }
            ]
        });
        vectorLayerOfSelected = new maptalks.VectorLayer('vectorSelected', multipointSelected).addTo(map);
    })
    .fail(function() {
        // Species map highlight failed silently — the main map remains visible
    });
}

function setAddress(coords) {
    $('#address').val(coords);
}
