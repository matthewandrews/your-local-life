
$(document).ready(function () {
    $('.your-local-life-title').fadeIn(1000, function() {
        $('.begin-para').fadeIn(1000, function() {
            $('.where-para').fadeIn(1000, function() {
                // wait for input
            })
        });
    });
});

var longitude;
var latitude;
var radius = 3;

$(document).on('submit', '#searchForm',function(e){
    searchPending();

    let coords = $('#address').val()
    if (coords.length < 3 || coords.indexOf(',') < 1) {
        // used default coordinates
        coords = '-35.2,149.1'
    }
    longitude = coords.split(',')[1]
    latitude = coords.split(',')[0]

    var biocacheUrl = "https://biocache.ala.org.au/ws";
    $.get(biocacheUrl + "/occurrences/search?q=*:*&radius=" + radius + "&lon=" + longitude + "&lat=" + latitude + "&fl=id,image_url&fq=images:*&pageSize=100&facet=true&facets=point-0.0001,vernacularName&flimit=-1", function (data) {
        //compressLocation();
        $('.begin-para').text('Here is what we found for latitude '+latitude+', longitude '+ longitude+'...');
        $('.begin-para').fadeIn(1000, function() {
            //console.log(data);

            makeMap(data);

            showSpecies(data);

            //insertImages(data);

            //insertCommonnames(data);

        });
    })
    return false; // cancel original event to prevent form submitting
});

function searchPending() {
    $('.where-para').hide();
    $('.begin-para').hide();
    $('.begin-para').text('Retrieving your results...');
    $('.begin-para').fadeIn(1000);
}

function compressLocation() {
    $('.begin-para').hide();
    $('.begin-para').text('Here&apos;s what we found for LOCATION...');
    $('.begin-para').fadeIn(1000);
}

function insertImages(data) {
    for (var i = 0; i < data.occurrences.length; i++) {
        $('#imageEnd').prepend('<img class="speciesImage" src="' + data.occurrences[i].thumbnailUrl + '" />');
    }
}

function insertCommonnames(data) {
    for (var i = 0; i < data.facetResults[1].fieldResult.length; i++) {
        var commonname = data.facetResults[1].fieldResult[i].label;
        if (commonname != 'Not supplied') {
            $('#commonnameEnd').prepend('<span class="commonname"><a href="https://bie.ala.org.au/search?q=' + commonname + '" target="_blank">' + commonname + '</a></span> ');
        }
    }
}

function showSpecies(data) {

    (async () => {
        for (var i = 0; i < data.facetResults[1].fieldResult.length; i++) {
          await new Promise((resolve) => {setTimeout(() => {
            let commonname = data.facetResults[1].fieldResult[i].label;
            if (commonname != 'Not supplied') {
                let speciesURL = "https://bie.ala.org.au/species/" + commonname;
                $.get("https://bie.ala.org.au/ws/species/" + commonname, function (data) {
                    if (data.imageIdentifier != null) {
                        let imageURL = "https://images.ala.org.au/image/proxyImageThumbnail?imageId=" + data.imageIdentifier;
                        $('#localSpecies').append('<div class="localSpeciesCard" onclick="showOnMap(\'' + data.taxonConcept.guid + '\')"><div class="localSpeciesCardImage"><a href="' + speciesURL + '"><img src="' + imageURL + '" alt="' + commonname + '" /></a></div><div class="localSpeciesCardText"></div><a href="' + speciesURL + '">' + commonname + '</a></div></div>');
                        $('#localSpecies div:last').hide().fadeIn(1000);
                    }
                });

            }

            resolve(true)}, 1000)});
        }
    })()
}

var map;
function makeMap(data) {

    map = new maptalks.Map('map', {
        center: [longitude,latitude],
        zoom: 14,
        pitch: 40,
        dragPitch : true,
        dragRotate: true,
        dragRotatePitch:true,
        baseLayer: new maptalks.TileLayer('base', {
            urlTemplate: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            subdomains: ["a","b","c","d"],
            attribution: '&copy; <a href="http://osm.org">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/">CARTO</a>'
        })

    });

    addMarkers(data);
}

function addMarkers(data) {

    var points = [];
    for (var i = 0; i < data.facetResults[0].fieldResult.length; i++) {
        var point = data.facetResults[0].fieldResult[i].label.split(',')
        var coord = [point[1], point[0]];
        points[i] = coord;
    }

    var multipoint = new maptalks.MultiPoint(points, {
        visible : true,
        editable : true,
        cursor : 'pointer',
        draggable : false,
        dragShadow : false, // display a shadow during dragging
        drawOnAxis : null,  // force dragging stick on a axis, can be: x, y
        symbol : [
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#fff',
                    'markerFillOpacity' : 1,
                    'markerWidth' : 3,
                    'markerHeight' : 3,
                    'markerLineWidth' : 0
                },
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#1bc8ff',
                    'markerFillOpacity' : 0.9,
                    'markerWidth' : 3,
                    'markerHeight' : 3,
                    'markerLineWidth' : 0
                },
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#0096cd',
                    'markerFillOpacity' : 0.8,
                    'markerWidth' : 3,
                    'markerHeight' : 3,
                    'markerLineWidth' : 0
                },
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#0096cd',
                    'markerFillOpacity' : 0.3,
                    'markerWidth' : 4,
                    'markerHeight' : 4,
                    'markerLineWidth' : 0
                },
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#0096cd',
                    'markerFillOpacity' : 0.2,
                    'markerWidth' : 5,
                    'markerHeight' : 5,
                    'markerLineWidth' : 0
                }
            ]

    });
    new maptalks.VectorLayer('vector', multipoint).addTo(map);
}

var vectorLayerOfSelected = null
function showOnMap(lsid) {

    if (vectorLayerOfSelected != null) {
        map.removeLayer(vectorLayerOfSelected)
        vectorLayerOfSelected = null
    }

    $.get("https://biocache-ws.ala.org.au/ws/occurrences/search?q=taxonConceptID:" + lsid + "&radius=" + radius + "&lon=" + longitude + "&lat=" + latitude + "&fl=id,image_url&fq=images:*&pageSize=100&facet=true&facets=point-0.0001,vernacularName&flimit=-1", function (data) {
        var points = [];
        for (var i = 0; i < data.facetResults[0].fieldResult.length; i++) {
            var point = data.facetResults[0].fieldResult[i].label.split(',')
            var coord = [point[1], point[0]];
            points[i] = coord;
        }

        var multipointSelectedSpecies = new maptalks.MultiPoint(points, {
            visible : true,
            editable : true,
            cursor : 'pointer',
            draggable : false,
            dragShadow : false, // display a shadow during dragging
            drawOnAxis : null,  // force dragging stick on a axis, can be: x, y
            symbol : [
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#fff',
                    'markerFillOpacity' : 1,
                    'markerWidth' : 1,
                    'markerHeight' : 1,
                    'markerLineWidth' : 0
                },
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#1bc8ff',
                    'markerFillOpacity' : 0.9,
                    'markerWidth' : 2,
                    'markerHeight' : 2,
                    'markerLineWidth' : 0
                },
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#ff0000',
                    'markerFillOpacity' : 0.8,
                    'markerWidth' : 3,
                    'markerHeight' : 3,
                    'markerLineWidth' : 0
                },
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#ff0000',
                    'markerFillOpacity' : 0.7,
                    'markerWidth' : 4,
                    'markerHeight' : 4,
                    'markerLineWidth' : 0
                },
                {
                    'markerType' : 'ellipse',
                    'markerFill' : '#ff0000',
                    'markerFillOpacity' : 0.6,
                    'markerWidth' : 8,
                    'markerHeight' : 8,
                    'markerLineWidth' : 0
                }
            ]

        });
        vectorLayerOfSelected = new maptalks.VectorLayer('vectorSelected', multipointSelectedSpecies).addTo(map);
    })


}

function setAddress(coords) {
    $('#address').val(coords)
}
