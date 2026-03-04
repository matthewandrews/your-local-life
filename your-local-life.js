
function ensureTourListShell() {
    var $tourList = $('#tourList');
    if (!$tourList.length) return;

    // Task 4: results render directly into #tourList as vertical sections.
    // Clear any legacy preview/grid content if present.
    $tourList.empty();
}

function setUiStateInitial() {
    $('body').removeClass('has-results');

    // Intro hero
    $('.your-local-life-title').show();
    $('.where-para').show();

    // Results header
    $('#pauseResume').hide();
    $('#searchAgain').hide();
    $('.result-bar').hide();

    // Clear prior content remnants
    $('#tourList').scrollTop(0);
    $('#tourList').empty();
}

function setUiStateSearching(message) {
    $('body').addClass('has-results');

    $('.your-local-life-title').hide();
    $('.where-para').hide();

    $('#pauseResume').hide();
    $('#searchAgain').hide();
    $('.begin-para').text(message || 'Retrieving your results...');
    $('.result-bar').show();

    ensureTourListShell();
}

function setUiStateResults(placeLabel) {
    $('body').addClass('has-results');

    $('.your-local-life-title').hide();
    $('.where-para').hide();

    var place = (placeLabel && String(placeLabel).trim().length) ? String(placeLabel).trim() : 'your area';
    $('.begin-para').text('Your tour of the local life near ' + place);

    $('#searchAgain').show();
    $('.result-bar').show();
}

function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function revealOrFadeIn($el, durationMs) {
    if (!$el || !$el.length) return;
    if (prefersReducedMotion()) {
        $el.stop(true, true).show();
        return;
    }
    $el.stop(true, true).fadeIn(durationMs || 0);
}

$(document).ready(function () {
    setUiStateInitial();

    // If intro elements are still hidden (e.g. initial CSS), reveal them with a gentle fade.
    var $title = $('.your-local-life-title');
    var $where = $('.where-para');
    if ($title.is(':hidden')) {
        if (prefersReducedMotion()) {
            $title.stop(true, true).show();
            if ($where.is(':hidden')) $where.stop(true, true).show();
        } else {
            $title.stop(true, true).fadeIn(1000, function() {
                if ($where.is(':hidden')) $where.stop(true, true).fadeIn(1000);
            });
        }
    } else if ($where.is(':hidden')) {
        revealOrFadeIn($where, 1000);
    }
});

var longitude;
var latitude;
var radius = 3;
var map = null;
var speciesPaused = false;
var speciesRunId = 0;

// Task 6 (Optional): auto-highlight current species while scrolling.
var tourSpeciesObserver = null;
var tourSpeciesObserverRunId = 0;
var tourSpeciesMetrics = null; // guid -> { ratio, topDist, isVisible }
var tourSpeciesPrimaryGuid = null;
var tourSpeciesAutoShowTimer = null;
var tourSpeciesAutoShowPendingGuid = null;
var tourSpeciesAutoShowLastAt = 0;
var TOUR_SPECIES_AUTO_DEBOUNCE_MS = 120;
var TOUR_SPECIES_AUTO_MIN_INTERVAL_MS = 450;
var tourSpeciesManualSelectedGuid = null;
var tourSpeciesManualSelectUntilAt = 0;
var tourSpeciesPickTimer = null;

// Per-run cache for highlighted species points to avoid repeat network calls.
var selectedSpeciesPointsCache = Object.create(null);
var selectedSpeciesRequestCache = Object.create(null);
var selectedSpeciesCacheRunId = 0;
var mapHighlightRequestedLsid = null;
var mapHighlightRequestedRunId = 0;

var _colorSampleCanvas = null;
var _colorSampleCtx = null;

function scheduleIdleWork(workFn, timeoutMs) {
    var t = (timeoutMs == null) ? 800 : timeoutMs;
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        return { kind: 'idle', id: window.requestIdleCallback(function() { workFn(); }, { timeout: t }) };
    }
    return { kind: 'timeout', id: setTimeout(workFn, t) };
}

function cancelIdleWork(handle) {
    if (!handle) return;
    if (handle.kind === 'idle') {
        if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(handle.id);
        }
        return;
    }
    clearTimeout(handle.id);
}

function resetSelectedSpeciesCacheForRun(runId) {
    // Abort any inflight jqXHRs before clearing caches.
    if (selectedSpeciesRequestCache) {
        for (var lsid in selectedSpeciesRequestCache) {
            if (!Object.prototype.hasOwnProperty.call(selectedSpeciesRequestCache, lsid)) continue;
            var req = selectedSpeciesRequestCache[lsid];
            if (req && typeof req.abort === 'function') {
                try { req.abort(); } catch (e) {}
            }
        }
    }

    selectedSpeciesCacheRunId = runId;
    selectedSpeciesPointsCache = Object.create(null);
    selectedSpeciesRequestCache = Object.create(null);
    mapHighlightRequestedLsid = null;
    mapHighlightRequestedRunId = runId;
}

function teardownTourSpeciesObserver() {
    if (tourSpeciesObserver) {
        try { tourSpeciesObserver.disconnect(); } catch (e) {}
        tourSpeciesObserver = null;
    }
    tourSpeciesObserverRunId = 0;
    tourSpeciesMetrics = null;
    tourSpeciesPrimaryGuid = null;
    if (tourSpeciesAutoShowTimer) {
        clearTimeout(tourSpeciesAutoShowTimer);
        tourSpeciesAutoShowTimer = null;
    }
    tourSpeciesAutoShowPendingGuid = null;
    tourSpeciesAutoShowLastAt = 0;
    tourSpeciesManualSelectedGuid = null;
    tourSpeciesManualSelectUntilAt = 0;
    if (tourSpeciesPickTimer) {
        clearTimeout(tourSpeciesPickTimer);
        tourSpeciesPickTimer = null;
    }
}

function ensureTourSpeciesObserver(runId) {
    if (runId !== speciesRunId) return;

    if (tourSpeciesObserver && tourSpeciesObserverRunId === runId) return;

    teardownTourSpeciesObserver();
    tourSpeciesObserverRunId = runId;
    tourSpeciesMetrics = Object.create(null);

    var rootEl = document.getElementById('tourList');
    if (!rootEl || typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') return;

    tourSpeciesObserver = new IntersectionObserver(function(entries) {
        if (runId !== speciesRunId) return;
        if (!tourSpeciesMetrics) tourSpeciesMetrics = Object.create(null);

        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var target = entry.target;
            if (!target) continue;
            var guid = target.getAttribute('data-guid');
            if (!guid) continue;

            var rootTop = (entry.rootBounds && isFinite(entry.rootBounds.top)) ? entry.rootBounds.top : 0;
            var topDist = (entry.boundingClientRect && isFinite(entry.boundingClientRect.top)) ? (entry.boundingClientRect.top - rootTop) : 0;
            tourSpeciesMetrics[guid] = {
                ratio: entry.intersectionRatio || 0,
                topDist: topDist,
                isVisible: !!entry.isIntersecting && (entry.intersectionRatio || 0) > 0
            };
        }

        schedulePrimaryTourSpeciesPick(runId);
    }, {
        root: rootEl,
        threshold: [0, 0.25, 0.5, 0.75]
    });

    // Kick once in case initial intersections are already computed.
    schedulePrimaryTourSpeciesPick(runId);

    // Observe any existing sections already in the list.
    $('#tourList .tour-species').each(function() {
        if (runId !== speciesRunId) return false;
        try { tourSpeciesObserver.observe(this); } catch (e) {}
    });
}

function observeTourSpeciesSection(sectionEl, runId) {
    if (!sectionEl) return;
    if (runId !== speciesRunId) return;
    ensureTourSpeciesObserver(runId);
    if (!tourSpeciesObserver || tourSpeciesObserverRunId !== runId) return;
    try { tourSpeciesObserver.observe(sectionEl); } catch (e) {}
}

function pickPrimaryTourSpeciesGuid() {
    if (!tourSpeciesMetrics) return null;

    var bestGuid = null;
    var bestRatio = -1;
    var bestTopScore = Infinity;
    var headerOffset = 8;

    for (var guid in tourSpeciesMetrics) {
        if (!Object.prototype.hasOwnProperty.call(tourSpeciesMetrics, guid)) continue;
        var m = tourSpeciesMetrics[guid];
        if (!m || !m.isVisible) continue;

        var ratio = m.ratio || 0;
        // Tie-breaker: prefer the section whose top is closest to the top of the scroll container.
        var topScore = Math.abs((m.topDist || 0) - headerOffset);

        if (ratio > bestRatio || (ratio === bestRatio && topScore < bestTopScore)) {
            bestGuid = guid;
            bestRatio = ratio;
            bestTopScore = topScore;
        }
    }

    return bestGuid;
}

function schedulePrimaryTourSpeciesUpdate(runId) {
    if (runId !== speciesRunId) return;
    var guid = pickPrimaryTourSpeciesGuid();
    if (!guid) return;
    if (guid === tourSpeciesPrimaryGuid) return;

    var now = Date.now();
    if (tourSpeciesManualSelectUntilAt && now < tourSpeciesManualSelectUntilAt && tourSpeciesManualSelectedGuid && guid !== tourSpeciesManualSelectedGuid) {
        return;
    }

    tourSpeciesPrimaryGuid = guid;

    // Keep list selection in sync, but avoid re-running click handlers.
    var $section = $('#tourList .tour-species').filter(function() {
        return $(this).attr('data-guid') === guid;
    });
    if ($section.length) {
        $('#tourList .tour-species.is-selected').removeClass('is-selected').removeAttr('aria-current');
        $section.addClass('is-selected');
        $section.attr('aria-current', 'true');
    }

    scheduleAutoShowOnMap(guid, runId);
}

function schedulePrimaryTourSpeciesPick(runId) {
    if (runId !== speciesRunId) return;
    if (tourSpeciesPickTimer) return;
    tourSpeciesPickTimer = setTimeout(function() {
        tourSpeciesPickTimer = null;
        if (runId !== speciesRunId) return;
        schedulePrimaryTourSpeciesUpdate(runId);
    }, 60);
}

function scheduleAutoShowOnMap(guid, runId) {
    if (!guid) return;
    if (runId !== speciesRunId) return;

    tourSpeciesAutoShowPendingGuid = guid;

    var now = Date.now();
    var minAt = tourSpeciesAutoShowLastAt + TOUR_SPECIES_AUTO_MIN_INTERVAL_MS;
    var delay = TOUR_SPECIES_AUTO_DEBOUNCE_MS;
    if (now + delay < minAt) delay = Math.max(delay, minAt - now);

    if (tourSpeciesAutoShowTimer) {
        clearTimeout(tourSpeciesAutoShowTimer);
        tourSpeciesAutoShowTimer = null;
    }

    tourSpeciesAutoShowTimer = setTimeout(function() {
        tourSpeciesAutoShowTimer = null;
        if (runId !== speciesRunId) return;
        var toShow = tourSpeciesAutoShowPendingGuid;
        tourSpeciesAutoShowPendingGuid = null;
        if (!toShow) return;

        // Don't let auto-show override a recent manual selection.
        var now = Date.now();
        if (tourSpeciesManualSelectUntilAt && now < tourSpeciesManualSelectUntilAt && tourSpeciesManualSelectedGuid && toShow !== tourSpeciesManualSelectedGuid) {
            return;
        }

        tourSpeciesAutoShowLastAt = Date.now();
        showOnMap(toShow);
    }, delay);
}

function srgbChannelToLinear(c) {
    var v = c / 255;
    return (v <= 0.03928) ? (v / 12.92) : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r, g, b) {
    var rLin = srgbChannelToLinear(r);
    var gLin = srgbChannelToLinear(g);
    var bLin = srgbChannelToLinear(b);
    return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

function pickReadableFg(r, g, b) {
    // Threshold tuned for #111 vs white.
    return relativeLuminance(r, g, b) > 0.45 ? '#111' : '#fff';
}

function clampByte(n) {
    return Math.max(0, Math.min(255, n | 0));
}

function sampleImageColor(img) {
    // CPU-safe sampling: aggressively downscale and stride pixels.
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;

    var target = 24;
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var scale = Math.min(target / w, target / h, 1);
    var dw = Math.max(1, Math.floor(w * scale));
    var dh = Math.max(1, Math.floor(h * scale));

    if (!_colorSampleCanvas) {
        _colorSampleCanvas = document.createElement('canvas');
        _colorSampleCtx = _colorSampleCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!_colorSampleCtx) return null;

    _colorSampleCanvas.width = dw;
    _colorSampleCanvas.height = dh;
    _colorSampleCtx.clearRect(0, 0, dw, dh);
    _colorSampleCtx.drawImage(img, 0, 0, dw, dh);

    try {
        var data = _colorSampleCtx.getImageData(0, 0, dw, dh).data;
        var stride = 2; // sample every 2nd pixel in each axis
        var rSum = 0;
        var gSum = 0;
        var bSum = 0;
        var count = 0;

        for (var y = 0; y < dh; y += stride) {
            for (var x = 0; x < dw; x += stride) {
                var idx = (y * dw + x) * 4;
                var a = data[idx + 3];
                if (a < 32) continue;
                rSum += data[idx];
                gSum += data[idx + 1];
                bSum += data[idx + 2];
                count += 1;
            }
        }

        if (!count) return null;
        return {
            r: clampByte(Math.round(rSum / count)),
            g: clampByte(Math.round(gSum / count)),
            b: clampByte(Math.round(bSum / count))
        };
    } catch (e) {
        // Likely tainted canvas (CORS) or security error.
        return null;
    }
}

function applySpeciesCardColors(cardEl, rgb) {
    if (!cardEl) return;
    if (!rgb) {
        // Safe fallback: keep CSS defaults.
        cardEl.style.removeProperty('--species-bg');
        cardEl.style.removeProperty('--species-fg');
        cardEl.style.removeProperty('--species-scrim');
        return;
    }
    var fg = pickReadableFg(rgb.r, rgb.g, rgb.b);
    cardEl.style.setProperty('--species-bg', 'rgb(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ')');
    cardEl.style.setProperty('--species-fg', fg);
    cardEl.style.setProperty('--species-scrim', fg === '#fff' ? 'rgba(0, 0, 0, 0.30)' : 'rgba(255, 255, 255, 0.60)');
}

function sampleSpeciesCardColorsFromUrl(cardEl, src, runId) {
    // Use an offscreen sampler image with CORS enabled for canvas.
    // Never set crossOrigin on the visible <img>, so it always has the best chance to display.
    if (!cardEl || !src) return;
    if (runId != null && runId !== speciesRunId) return;
    if (!cardEl.isConnected) return;

    var sampler = new Image();
    sampler.crossOrigin = 'anonymous';
    sampler.onload = function() {
        if (runId != null && runId !== speciesRunId) return;
        if (!cardEl.isConnected) return;
        var rgb = sampleImageColor(sampler);
        if (runId != null && runId !== speciesRunId) return;
        applySpeciesCardColors(cardEl, rgb);
    };
    sampler.onerror = function() {
        if (runId != null && runId !== speciesRunId) return;
        // Best-effort: leave CSS defaults; do not affect visible image.
        applySpeciesCardColors(cardEl, null);
    };
    sampler.src = src;
}

$(document).on('click', '#pauseResume', function() {
    speciesPaused = !speciesPaused;
    updatePauseResumeButton();
});

$(document).on('click', '.tour-species', function(e) {
    // When clicking on a link, still allow it to open, but also sync the map.
    var $section = $(this);
    var guid = $section.attr('data-guid');
    if (!guid) return;

    // Cancel any pending auto-show so it can't override this manual selection.
    if (tourSpeciesAutoShowTimer) {
        clearTimeout(tourSpeciesAutoShowTimer);
        tourSpeciesAutoShowTimer = null;
    }
    tourSpeciesAutoShowPendingGuid = null;

    // Temporarily prefer the user's explicit selection over scroll-based auto selection.
    tourSpeciesManualSelectedGuid = guid;
    tourSpeciesManualSelectUntilAt = Date.now() + 1500;

    // Treat a click as the primary selection right away.
    tourSpeciesPrimaryGuid = guid;

    $('#tourList .tour-species.is-selected').removeClass('is-selected').removeAttr('aria-current');
    $section.addClass('is-selected');
    $section.attr('aria-current', 'true');
    showOnMap(guid);
});

$(document).on('keydown', '.tour-species', function(e) {
    // Make the whole section keyboard-operable, without interfering with links inside.
    if (e.target !== this) return;
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $(this).trigger('click');
    }
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
        var runId = speciesRunId;
        $.get('https://nominatim.openstreetmap.org/search', {
            q: inputVal,
            format: 'json',
            limit: 1,
            countrycodes: 'au'
        })
        .done(function(results) {
            if (runId !== speciesRunId) return;
            if (!results || results.length === 0) {
                showError('Could not find that location. Please try a more specific address or use GPS coordinates.');
                return;
            }
            latitude  = results[0].lat;
            longitude = results[0].lon;
            doSearch();
        })
        .fail(function() {
            if (runId !== speciesRunId) return;
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
    var runId = speciesRunId;

    var biocacheUrl = 'https://biocache.ala.org.au/ws';
    $.get(biocacheUrl + '/occurrences/search?q=*:*&radius=' + radius + '&lon=' + longitude + '&lat=' + latitude + '&fl=id,image_url&fq=images:*&pageSize=100&facet=true&facets=point-0.0001,vernacularName&flimit=-1')
    .done(function(data) {
        if (runId !== speciesRunId) return;
        if (!data.facetResults || data.facetResults.length < 2) {
            showError('No species data found for this location. Try a different area.');
            return;
        }
        var coordsText = formatCoords(latitude, longitude);
        setUiStateResults(coordsText);
        reverseGeocode(latitude, longitude, runId);
        makeMap(data);
        showSpecies(data);
    })
    .fail(function() {
        if (runId !== speciesRunId) return;
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
        setUiStateResults(place);
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
    setUiStateSearching(message);

    teardownTourSpeciesObserver();
    resetSelectedSpeciesCacheForRun(speciesRunId);
}

function showError(message) {
    $('body').removeClass('has-results');
    $('#pauseResume').hide();
    $('#searchAgain').hide();
    $('.begin-para').text(message);
    revealOrFadeIn($('.result-bar'), 500);
    revealOrFadeIn($('.your-local-life-title'), 500);
    revealOrFadeIn($('.where-para'), 500);
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
    // Ensure container is ready before rendering
    ensureTourListShell();

    var runId = speciesRunId;
    speciesPaused = false;
    updatePauseResumeButton();
    $('#pauseResume').show();

    resetSelectedSpeciesCacheForRun(runId);

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
        var $tourList = $('#tourList');
        var reduceMotion = prefersReducedMotion();

        // Ensure intersection observer is scoped to this run.
        ensureTourSpeciesObserver(runId);

        for (var i = 0; i < speciesList.length; i++) {
            if (!reduceMotion) {
                await new Promise((resolve) => setTimeout(resolve, 2700));
            }
            if (runId !== speciesRunId) return;

            var canContinue = await waitWhilePaused(runId);
            if (!canContinue) return;
            if (runId !== speciesRunId) return;

            var commonname = speciesList[i].label;
            if (commonname === 'Not supplied') continue;

            var speciesURL = 'https://bie.ala.org.au/species/' + encodeURIComponent(commonname);
            var speciesData = await $.get('https://bie.ala.org.au/ws/species/' + encodeURIComponent(commonname))
                .then(
                    function(d) { return d; },
                    function() { return null; }
                );
            if (runId !== speciesRunId) return;
            if (!speciesData || speciesData.imageIdentifier == null) continue;

            canContinue = await waitWhilePaused(runId);
            if (!canContinue) return;
            if (runId !== speciesRunId) return;

            var guid = speciesData.taxonConcept && speciesData.taxonConcept.guid;
            if (!guid) continue;

            var imageURL = 'https://images.ala.org.au/image/proxyImageThumbnail?imageId=' + speciesData.imageIdentifier;

            var $section = $('<section>')
                .addClass('tour-species')
                .attr('data-guid', guid)
                .attr('tabindex', '0')
                .attr('role', 'button');

            var $card = $('<div>').addClass('tour-card');
            var $imageLink = $('<a>')
                .addClass('tour-image-link')
                .attr('href', speciesURL)
                .attr('target', '_blank')
                .attr('rel', 'noopener');
            var $image = $('<img>')
                .addClass('tour-image')
                .attr('alt', commonname);

            $image.on('load', function() {
                var imgEl = this;
                var $ownerCard = $(imgEl).closest('.tour-card');
                if (!$ownerCard.length) return;

                if (runId !== speciesRunId) return;

                // Schedule sampling so reduced-motion mode doesn't spike CPU.
                var src = imgEl.currentSrc || imgEl.src;
                var cardEl = $ownerCard[0];
                if (cardEl._idleHandle) {
                    cancelIdleWork(cardEl._idleHandle);
                    cardEl._idleHandle = null;
                }
                cardEl._idleHandle = scheduleIdleWork(function() {
                    cardEl._idleHandle = null;
                    if (runId !== speciesRunId) return;
                    if (!cardEl.isConnected) return;

                    // Try sampling from the visible image first (no extra request).
                    // If the canvas is tainted (CORS), fall back to the offscreen sampler.
                    var rgb = null;
                    try {
                        rgb = sampleImageColor(imgEl);
                    } catch (e) {
                        rgb = null;
                    }
                    if (runId !== speciesRunId) return;
                    if (!cardEl.isConnected) return;
                    if (rgb) {
                        applySpeciesCardColors(cardEl, rgb);
                        return;
                    }

                    sampleSpeciesCardColorsFromUrl(cardEl, src, runId);
                }, 800);
            });

            // Set src last so handlers are in place.
            $image.attr('src', imageURL);
            $imageLink.append($image);

            var $nameLink = $('<a>')
                .addClass('tour-name')
                .attr('href', speciesURL)
                .attr('target', '_blank')
                .attr('rel', 'noopener')
                .text(commonname);

            $card.append($imageLink, $nameLink);
            $section.append($card);

            $tourList.append($section);

            // Track visible sections for auto-highlighting while scrolling.
            observeTourSpeciesSection($section[0], runId);
            if (!reduceMotion) {
                $section.hide().fadeIn(450);
            }

            // Keep map + list in sync as species appear.
            $('#tourList .tour-species.is-selected').removeClass('is-selected').removeAttr('aria-current');
            $section.addClass('is-selected');
            $section.attr('aria-current', 'true');
            showOnMap(guid);
        }

        if (runId !== speciesRunId) return;
        $('#pauseResume').hide();
    })();
}

$(document).on('click', '#searchAgain', function() {
    // Invalidate any pending async work
    speciesRunId += 1;
    speciesPaused = false;
    updatePauseResumeButton();

    teardownTourSpeciesObserver();
    resetSelectedSpeciesCacheForRun(speciesRunId);

    // Cancel any scheduled color sampling work before tearing down the list.
    $('#tourList .tour-card').each(function() {
        if (this._idleHandle) {
            cancelIdleWork(this._idleHandle);
            this._idleHandle = null;
        }
    });

    if (map !== null && vectorLayerOfSelected !== null) {
        map.removeLayer(vectorLayerOfSelected);
        vectorLayerOfSelected = null;
    }

    $('#tourList .tour-species.is-selected').removeClass('is-selected').removeAttr('aria-current');

    setUiStateInitial();
    $('#tourList').empty();
});

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
    var runId = speciesRunId;

    if (selectedSpeciesCacheRunId !== runId) {
        resetSelectedSpeciesCacheForRun(runId);
    }

    if (map === null) {
        // Allow list interaction even when map isn't ready yet.
        return;
    }

    // Guard against repeated requests for the same species.
    if (lsid === mapHighlightRequestedLsid && runId === mapHighlightRequestedRunId) {
        return;
    }
    mapHighlightRequestedLsid = lsid;
    mapHighlightRequestedRunId = runId;

    if (vectorLayerOfSelected !== null) {
        map.removeLayer(vectorLayerOfSelected);
        vectorLayerOfSelected = null;
    }

    function renderSelectedPoints(points) {
        if (runId !== speciesRunId) return;
        if (map === null) return;
        if (!points || !points.length) return;
        if (lsid !== mapHighlightRequestedLsid || runId !== mapHighlightRequestedRunId) return;

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

        if (runId !== speciesRunId) return;
        if (lsid !== mapHighlightRequestedLsid || runId !== mapHighlightRequestedRunId) return;
        vectorLayerOfSelected = new maptalks.VectorLayer('vectorSelected', multipointSelected).addTo(map);
    }

    var cached = selectedSpeciesPointsCache[lsid];
    if (cached) {
        renderSelectedPoints(cached);
        return;
    }

    // If there's already an inflight request, let it finish; don't start another.
    if (selectedSpeciesRequestCache[lsid]) {
        return;
    }

    selectedSpeciesRequestCache[lsid] = $.get('https://biocache.ala.org.au/ws/occurrences/search?q=taxonConceptID:' + encodeURIComponent(lsid) + '&radius=' + radius + '&lon=' + longitude + '&lat=' + latitude + '&fl=id,image_url&fq=images:*&pageSize=100&facet=true&facets=point-0.0001,vernacularName&flimit=-1')
    .done(function(data) {
        delete selectedSpeciesRequestCache[lsid];
        if (runId !== speciesRunId) return;
        if (!data.facetResults || !data.facetResults[0]) return;
        var points = parsePoints(data.facetResults[0].fieldResult);
        selectedSpeciesPointsCache[lsid] = points;
        renderSelectedPoints(points);
    })
    .fail(function() {
        delete selectedSpeciesRequestCache[lsid];
        // Species map highlight failed silently — the main map remains visible
    });
}

function setAddress(coords) {
    $('#address').val(coords);
}
