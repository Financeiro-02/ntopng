// 2018 - ntop.org

var schema_2_label = {};
var data_2_label = {};
var graph_i18n = {};

function initLabelMaps(_schema_2_label, _data_2_label, _graph_i18n) {
  schema_2_label = _schema_2_label;
  data_2_label = _data_2_label;
  graph_i18n = _graph_i18n;
};

function getSerieLabel(schema, serie) {
  var data_label = serie.label;
  var new_label = data_2_label[data_label];

  if((schema == "top:local_senders") || (schema == "top:local_receivers")) {
    return serie.tags.host
  } else if(schema.startsWith("top:")) { // topk graphs
    if(serie.tags.protocol)
      return serie.tags.protocol;
    else if(serie.tags.category)
      return serie.tags.category
    else if(serie.tags.device && serie.tags.if_index) { // SNMP interface
      if(serie.tags.if_index != serie.ext_label)
        return serie.ext_label + " (" + serie.tags.if_index + ")";
      else
        return serie.ext_label;
    } else if(serie.tags.device && serie.tags.port) // Flow device
      return serie.tags.port;
    else if(serie.tags.profile)
        return serie.tags.profile;
  } else if(data_label != "bytes") { // single series
    if(serie.tags.protocol)
      return serie.tags.protocol + " (" + new_label + ")";
    else if(serie.tags.category)
      return serie.tags.category + " (" + new_label + ")";
    else if(serie.tags.device && serie.tags.if_index) // SNMP interface
      return serie.ext_label + " (" + new_label + ")";
    else if(serie.tags.device && serie.tags.port) // Flow device
      return serie.tags.port + " (" + new_label + ")";
  } else {
      if(serie.tags.protocol)
        return serie.tags.protocol;
      else if(serie.tags.category)
        return serie.tags.category;
      else if(serie.tags.profile)
        return serie.tags.profile;
      else if(data_label == "bytes") {
        if(schema.contains("volume"))
          return graph_i18n.traffic_volume;
        else
          return graph_i18n.traffic;
      }
  }

  if(schema_2_label[schema])
    return capitaliseFirstLetter(schema_2_label[schema]);

  if(new_label)
    return capitaliseFirstLetter(new_label);

  // default
  return capitaliseFirstLetter(data_label);
}

// Value formatter
function getValueFormatter(schema, series) {
  if(series && series.length && series[0].label) {
    var label = series[0].label;

    if(label.contains("bytes")) {
      if(schema.contains("volume"))
        return [bytesToSize, bytesToSize];
      else
        return [fbits_from_bytes, bytesToSize];
    } else if(label.contains("packets"))
      return [fpackets, formatPackets];
    else if(label.contains("flows"))
      return [formatValue, formatFlows, formatFlows];
    else if(label.contains("millis"))
      return [fmillis, fmillis];
  }

  // fallback
  return [fint,fint];
}

function makeFlatLineValues(tstart, tstep, num, data) {
  var t = tstart;
  var values = [];

  for(var i=0; i<num; i++) {
    values[i] = [t, data ];
    t += tstep;
  }

  return values;
}

function checkSeriesConsinstency(schema_name, count, series) {
  var rv = true;

  for(var i=0; i<series.length; i++) {
    var data = series[i].data;

    if(data.length > count) {
        console.error("points mismatch: serie '" + getSerieLabel(schema_name, series[i]) +
          "' has " + data.length + " points, expected " + count);

      rv = false;
    } else if(data.length < count) {
      /* upsample */
      series[i].data = upsampleSerie(data, count);
    }
  }

  return rv;
}

function upsampleSerie(serie, num_points) {
  if(num_points <= serie.length)
    return serie;

  var res = [];
  var intervals = num_points / serie.length;

  function lerp(v0, v1, t) {
    return (1 - t) * v0 + t * v1;
  }

  for(var i=0; i<num_points; i++) {
    var index = i / intervals;
    var prev_i = Math.floor(index);
    var next_i = Math.min(Math.ceil(index), serie.length-1);
    var t = index % 1; // fractional part
    var v = lerp(serie[prev_i], serie[next_i], t);
    //console.log(prev_i, next_i, t, ">>", v);

    res.push(v);
  }

  return res.slice(0, num_points);
}

// the stacked total serie
function buildTotalSerie(data_series) {
  var series = [];

  for(var i=0; i<data_series.length; i++)
    series.push(data_series[i].data);

  return d3.transpose(series).map(function(x) {
    return x.map(function(g) {
      return g;
    });
  }).map(function(x) {return d3.sum(x);});
}

function arrayToNvSerie(serie_data, start, step) {
  var values = [];
  var t = start;

  for(var i=0; i<serie_data.length; i++) {
    values[i] = [t, serie_data[i]];
    t += step;
  }

  return values;
}

// computes the difference between visual_total and total_serie
function buildOtherSerie(total_serie, visual_total) {
  if(total_serie.length !== visual_total.length) {
    console.warn("Total/Visual length mismatch: " + total_serie.length + " vs " + visual_total.length);
    return;
  }

  var res = [];
  var max_val = 0;

  for(var i=0; i<total_serie.length; i++) {
    var value = Math.max(0, total_serie[i] - visual_total[i]);
    max_val = Math.max(max_val, value);

    res.push(value);
  }

  if(max_val > 0.1)
    return res;
}

function buildTimeArray(start_time, end_time, step) {
  var arr = [];

  for(var t=start_time; t<end_time; t+=step)
    arr.push(t);

  return arr;
}

function fixTimeRange(chart, params, align_step, actual_step) {
  var diff_epoch = (params.epoch_end - params.epoch_begin);
  var frame, align, tick_step, resolution, fmt = "%H:%M:%S";

  // must be sorted by ascending max_diff
  // max_diff / tick_step indicates the number of ticks, which should be <= 15
  // max_diff / resolution indicates the number of actual points, which should be ~300
  var range_params = [
    // max_diff, resolution, x_format, alignment, tick_step
    [15, 1, "%H:%M:%S", 1, 1],                          // <= 15 sec
    [60, 1, "%H:%M:%S", 1, 5],                          // <= 1 min
    [120, 1, "%H:%M:%S", 10, 10],                       // <= 2 min
    [300, 1, "%H:%M:%S", 10, 30],                       // <= 5 min
    [600, 5, "%H:%M:%S", 30, 60],                       // <= 10 min
    [1200, 5, "%H:%M:%S", 60, 120],                     // <= 20 min
    [3600, 10, "%H:%M:%S", 60, 300],                    // <= 1 h
    [5400, 15, "%H:%M", 300, 900],                      // <= 1.5 h
    [10800, 30, "%H:%M", 300, 900],                     // <= 3 h
    [21600, 60, "%H:%M", 3600, 1800],                   // <= 6 h
    [43200, 120, "%H:%M", 3600, 3600],                  // <= 12 h
    [86400, 240, "%H:%M", 3600, 7200],                  // <= 1 d
    [172800, 480, "%a, %H:%M", 3600, 14400],            // <= 2 d
    [604800, 1800, "%Y-%m-%d", 86400, 86400],           // <= 7 d
    [1209600, 3600, "%Y-%m-%d", 86400, 172800],         // <= 14 d
    [2678400, 7200, "%Y-%m-%d", 86400, 259200],         // <= 1 m
    [15768000, 43200, "%Y-%m-%d", 2678400, 1314000],    // <= 6 m
    [31622400, 86400, "%Y-%m-%d", 2678400, 2678400],    // <= 1 y
  ];

  for(var i=0; i<range_params.length; i++) {
    var range = range_params[i];

    if(diff_epoch <= range[0]) {
      frame = range[0];
      resolution = range[1];
      fmt = range[2];
      align = range[3];
      tick_step = range[4];
      break;
    }
  }

  resolution = Math.max(actual_step, resolution);

  if(align) {
    align = (align_step && (frame != 86400) /* do not align daily traffic to avoid jumping to other RRA */) ? Math.max(align, align_step) : 1;
    params.epoch_begin -= params.epoch_begin % align;
    params.epoch_end -= params.epoch_end % align;
    diff_epoch = (params.epoch_end - params.epoch_begin);
    params.limit = Math.ceil(diff_epoch / resolution);

    // align epoch end wrt params.limit
    params.epoch_end += Math.ceil(diff_epoch / params.limit) * params.limit - diff_epoch;

    chart.xAxis.tickValues(buildTimeArray(params.epoch_begin, params.epoch_end, tick_step));
    chart.align = align;
  }

  chart.xAxis.tickFormat(function(d) { return d3.time.format(fmt)(new Date(d*1000)) });
}

function findActualStep(raw_step, tstart) {
  if(typeof supported_steps === "object") {
    if(supported_steps[raw_step]) {
      var retention = supported_steps[raw_step].retention;

      if(retention) {
        var now_ts = Date.now() / 1000;
        var delta = now_ts - tstart;

        for(var i=0; i<retention.length; i++) {
          var partial = raw_step * retention[i].aggregation_dp;
          var tframe = partial * retention[i].retention_dp;
          delta -= tframe;

          if(delta <= 0)
            return partial;
        }
      }
    }
  }
  return raw_step;
}

function has_initial_zoom() {
  return typeof parseQuery(window.location.search).epoch_begin !== "undefined";
}

var current_zoom_level = (history.state) ? (history.state.zoom_level) : 0;

function fixJumpButtons(epoch_end) {
  var duration = $("#btn-jump-time-ahead").data("duration");
  if((epoch_end + duration)*1000 > $.now())
    $("#btn-jump-time-ahead").addClass("disabled");
  else
    $("#btn-jump-time-ahead").removeClass("disabled");
};

// add a new updateStackedChart function
function attachStackedChartCallback(chart, schema_name, chart_id, zoom_reset_id, params, step, align_step, show_all_smooth, initial_range) {
  var pending_request = null;
  var d3_sel = d3.select(chart_id);
  var $chart = $(chart_id);
  var $zoom_reset = $(zoom_reset_id);
  var $graph_zoom = $("#graph_zoom");
  var max_interval = findActualStep(step, params.epoch_begin) * 8;
  var initial_interval = (params.epoch_end - params.epoch_begin);
  var is_max_zoom = (initial_interval <= max_interval);
  var url = http_prefix + "/lua/get_ts.lua";
  var first_load = true;
  var first_time_loaded = true;
  var datetime_format = "dd/MM/yyyy hh:mm:ss";
  var max_over_total_ratio = 3;
  chart.is_zoomed = ((current_zoom_level > 0) || has_initial_zoom());

  //var spinner = $("<img class='chart-loading-spinner' src='" + spinner_url + "'/>");
  var spinner = $('<i class="chart-loading-spinner fa fa-spinner fa-lg fa-spin"></i>');
  $chart.parent().css("position", "relative");

  var chart_colors_full = [
    "#69B87F",
    "#94CFA4",
    "#B3DEB6",
    "#E5F1A6",
    "#FFFCC6",
    "#FEDEA5",
    "#FFB97B",
    "#FF8D6D",
    "#E27B85"
  ];

  var chart_colors_min = ["#7CC28F", "#FCD384", "#FD977B"];

  var update_chart_data = function(new_data) {
    /* reset chart data so that the next transition animation will be gracefull */
    d3_sel.datum([]).call(chart);

    d3_sel.datum(new_data).transition().call(chart);
    nv.utils.windowResize(chart.update);
    pending_request = null;
    spinner.remove();
  }

  function isLegendDisabled(key, default_val) {
    if(typeof localStorage !== "undefined") {
      var val = localStorage.getItem("chart_series.disabled." + key);

      if(val != null)
        return(val === "true");
    }

    return default_val;
  }

  chart.legend.dispatch.on('legendClick', function(d,i) {
    if(typeof localStorage !== "undefined")
      localStorage.setItem("chart_series.disabled." + d.legend_key, (!d.disabled) ? true : false);
  });

  chart.dispatch.on("zoom", function(e) {
    var cur_zoom = [params.epoch_begin, params.epoch_end];
    var t_start = Math.floor(e.xDomain[0]);
    var t_end = Math.ceil(e.xDomain[1]);
    var old_zoomed = chart.is_zoomed;
    var is_user_zoom = (typeof e.is_user_zoom !== "undefined") ? e.is_user_zoom : true;
    chart.is_zoomed = true;

    if(chart.updateStackedChart(t_start, t_end, false, is_user_zoom)) {
      if(is_user_zoom || e.push_state) {
        //console.log("zoom IN!");
        current_zoom_level += 1;
        var url = getHistoryParameters({epoch_begin: t_start, epoch_end: t_end});
        history.pushState({zoom_level: current_zoom_level, range: [t_start, t_end]}, "", url);
      }

      chart.fixChartButtons();
    } else
      chart.is_zoomed = old_zoomed;
  });

  function updateZoom(zoom, is_user_zoom, force) {
    var t_start = zoom[0];
    var t_end = zoom[1];

    chart.updateStackedChart(t_start, t_end, false, is_user_zoom, null, force);
    chart.fixChartButtons();
  }

  $chart.on('dblclick', function() {
    if(current_zoom_level) {
      //console.log("zoom OUT");
      history.back();
    }
  });

  $zoom_reset.on("click", function() {
    if(current_zoom_level) {
      //console.log("zoom RESET");
      history.go(-current_zoom_level);
    }
  });

  window.addEventListener('popstate', function(e) {
    var zoom = initial_range;
    //console.log("popstate: ", e.state);

    if(e.state) {
      zoom = e.state.range;
      current_zoom_level = e.state.zoom_level;
    } else
      current_zoom_level = 0;

    updateZoom(zoom, true, true /* force */);
  });

  chart.fixChartButtons = function() {
    if((current_zoom_level > 0) || has_initial_zoom()) {
      $graph_zoom.find(".btn-warning:not(.custom-zoom-btn)")
        .addClass("initial-zoom-sel")
        .removeClass("btn-warning");
      $graph_zoom.find(".custom-zoom-btn").css("visibility", "visible");

      var zoom_link = $graph_zoom.find(".custom-zoom-btn input");
      var link = zoom_link.val().replace(/&epoch_begin=.*/, "");
      link += "&epoch_begin=" + params.epoch_begin + "&epoch_end=" + params.epoch_end;
      zoom_link.val(link);
    } else {
      $graph_zoom.find(".initial-zoom-sel")
        .addClass("btn-warning");
      $graph_zoom.find(".custom-zoom-btn").css("visibility", "hidden");
      chart.is_zoomed = false;
    }

    fixJumpButtons(params.epoch_end);

    if(current_zoom_level > 0)
      $zoom_reset.show();
    else
      $zoom_reset.hide();
  }

  var old_start, old_end, old_interval;

  /* Returns false if zoom update is rejected. */
  chart.updateStackedChart = function (tstart, tend, no_spinner, is_user_zoom, on_load_callback, force_update) {
    if(tstart) params.epoch_begin = tstart;
    if(tend) params.epoch_end = tend;

    var cur_interval = (params.epoch_end - params.epoch_begin);
    var actual_step = findActualStep(step, params.epoch_begin);
    max_interval = actual_step * 6; /* host traffic 30 min */

    if(cur_interval < max_interval) {
      if((is_max_zoom && (cur_interval < old_interval)) && !force_update) {
        old_interval = cur_interval;
        return false;
      }

      /* Ensure that a minimal number of points is available */
      var epoch = params.epoch_begin + (params.epoch_end - params.epoch_begin) / 2;
      var new_end = Math.floor(epoch + max_interval / 2);

      if(new_end * 1000 >= Date.now()) {
        /* Only expand on the left side of the interval */
        params.epoch_begin = params.epoch_end - max_interval;
      } else {
        params.epoch_begin = Math.floor(epoch - max_interval / 2);
        params.epoch_end = Math.floor(epoch + max_interval / 2);
      }

      is_max_zoom = true;
      chart.zoomType(null); // disable zoom
    } else if (cur_interval > max_interval) {
      is_max_zoom = false;
      chart.zoomType('x'); // enable zoom
    }

    old_interval = cur_interval;

    if(!first_load || has_initial_zoom() || force_update)
      align_step = null;
    fixTimeRange(chart, params, align_step, actual_step);

    if(first_load)
      initial_range = [params.epoch_begin, params.epoch_end];

    if((old_start == params.epoch_begin) && (old_end == params.epoch_end))
      return false;

    old_start = params.epoch_begin;
    old_end = params.epoch_end;

    if(pending_request)
      pending_request.abort();
    else if(!no_spinner)
      spinner.appendTo($chart.parent());

    // Update datetime selection
    $("#period_begin").data("DateTimePicker").date(new Date(params.epoch_begin * 1000));
    $("#period_end").data("DateTimePicker")
      .maxDate(new Date($.now()))
      .date(new Date(Math.min(params.epoch_end * 1000, $.now())));

    // Load data via ajax
    pending_request = $.get(url, params, function(data) {
      if(!data || !data.series || !data.series.length || !checkSeriesConsinstency(schema_name, data.count, data.series)) {
        update_chart_data([]);
        return;
      }

      // Adapt data
      var res = [];
      var series = data.series;
      var total_serie;
      var color_i = 0;

      var chart_colors = (series.length <= chart_colors_min.length) ? chart_colors_min : chart_colors_full;

      for(var j=0; j<series.length; j++) {
        var values = [];
        var serie_data = series[j].data;

        var t = data.start;
        for(var i=0; i<serie_data.length; i++) {
          values[i] = [t, serie_data[i] ];
          t += data.step;
        }

        var label = getSerieLabel(schema_name, series[j]);
        var legend_key = schema_name + ":" + label;

        res.push({
          key: label,
          yAxis: series[j].axis || 1,
          values: values,
          type: series[j].type || "area",
          color: chart_colors[color_i++],
          legend_key: legend_key,
          disabled: isLegendDisabled(legend_key, false),
        });
      }

      var visual_total = buildTotalSerie(series);
      var has_full_data = false;

      if(data.additional_series && data.additional_series.total) {
        total_serie = data.additional_series.total;

        /* Total -> Other */
        var other_serie = buildOtherSerie(total_serie, visual_total);

        if(other_serie) {
          res.push({
            key: graph_i18n.other,
            yAxis: 1,
            values: arrayToNvSerie(other_serie, data.start, data.step),
            type: "area",
            color: chart_colors[color_i++],
            legend_key: "other",
            disabled: isLegendDisabled("other", false),
          });

          has_full_data = true;
        }
      } else {
        total_serie = visual_total;
        has_full_data = !schema_name.startsWith("top:");
      }

      var past_serie = null;

      if(data.additional_series) {
        for(var key in data.additional_series) {
          if(key == "total") {
            // handle manually as "other" above
            continue;
          }

          var serie_data = upsampleSerie(data.additional_series[key], data.count);
          var ratio_over_total = d3.max(serie_data) / d3.max(visual_total);
          var values = arrayToNvSerie(serie_data, data.start, data.step);
          var is_disabled = isLegendDisabled(key, false);
          past_serie = serie_data; // TODO: more reliable way to determine past serie

          /* Hide comparison serie at first load if it's too high */
          if(first_time_loaded && (ratio_over_total > max_over_total_ratio))
            is_disabled = true;

          res.push({
            key: capitaliseFirstLetter(key),
            yAxis: 1,
            values: values,
            type: "line",
            classed: "line-dashed line-animated",
            color: "#7E91A0",
            legend_key: key,
            disabled: is_disabled,
          });
        }
      }

      if(!data.no_trend && has_full_data && (total_serie.length >= 3)) {
        // Smoothed serie
        var num_smoothed_points = Math.max(Math.floor(total_serie.length / 5), 3);

        var smooth_functions = {
          trend: [graph_i18n.trend, "#62ADF6", smooth, num_smoothed_points],
          ema: ["EMA", "#F96BFF", exponentialMovingAverageArray, {periods: num_smoothed_points}],
          sma: ["SMA", "#A900FF", simpleMovingAverageArray, {periods: num_smoothed_points}],
          rsi: ["RSI cur vs past", "#00FF5D", relativeStrengthIndexArray, {periods: num_smoothed_points}],
        }

        function add_smoothed_serie(fn_to_use) {
          var options = smooth_functions[fn_to_use];
          var smoothed;

          if(fn_to_use == "rsi") {
            if(!past_serie)
              return;

            var delta_serie = [];
            for(var i=0; i<total_serie.length; i++) {
              delta_serie[i] = total_serie[i] - past_serie[i];
            }
            smoothed = options[2](delta_serie, options[3]);
          } else
            smoothed = options[2](total_serie, options[3]);
          
          var max_val = d3.max(smoothed);
          if(max_val > 0) {
            var aligned;

            if((fn_to_use != "ema") && (fn_to_use != "sma") && (fn_to_use != "rsi")) {
              var scale = d3.max(total_serie) / max_val;
              var scaled = $.map(smoothed, function(x) { return x * scale; });
              aligned = upsampleSerie(scaled, data.count);
            } else {
              var remaining = (data.count - smoothed.length);
              var to_fill = remaining < num_smoothed_points ? remaining : num_smoothed_points;

              /* Fill the initial buffering space */
              for(var i=0; i<to_fill; i++)
                smoothed.splice(0, 0, smoothed[0]);

              aligned = upsampleSerie(smoothed, data.count);
            }

            if(fn_to_use == "rsi")
              chart.yDomainRatioY2(1.0);

            res.push({
              key: options[0],
              yAxis: (fn_to_use != "rsi") ? 1 : 2,
              values: arrayToNvSerie(aligned, data.start, data.step),
              type: "line",
              classed: "line-animated",
              color: options[1],
              legend_key: fn_to_use,
              disabled: isLegendDisabled(fn_to_use, false),
            });
          }
        }

        if(show_all_smooth) {
          for(fn_to_use in smooth_functions)
            add_smoothed_serie(fn_to_use);
        } else
          add_smoothed_serie("trend");
      }

      // get the value formatter
      var formatter1 = getValueFormatter(schema_name, series.filter(function(d) { return(d.axis != 2); }));
      var value_formatter = formatter1[0];
      var tot_formatter = formatter1[1];
      var stats_formatter = formatter1[2] || value_formatter;
      chart.yAxis1.tickFormat(value_formatter);
      chart.yAxis1_formatter = value_formatter;

      var second_axis_series = series.filter(function(d) { return(d.axis == 2); });
      var formatter2 = getValueFormatter(schema_name, second_axis_series);
      var value_formatter2 = formatter2[0];
      chart.yAxis2.tickFormat(value_formatter2);
      chart.yAxis2_formatter = value_formatter2;

      var stats_table = $("#ts-chart-stats");
      var stats = data.statistics;

      if(stats) {
        if(stats.average) {
          var values = makeFlatLineValues(data.start, data.step, data.count, stats.average);

          res.push({
            key: graph_i18n.avg,
            yAxis: 1,
            values: values,
            type: "line",
            classed: "line-dashed line-animated",
            color: "#AC9DDF",
            legend_key: "avg",
            disabled: isLegendDisabled("avg", true),
          });
        }

        var total_cell = stats_table.find(".graph-val-total");
        var average_cell = stats_table.find(".graph-val-average");
        var min_cell = stats_table.find(".graph-val-min");
        var max_cell = stats_table.find(".graph-val-max");
        var perc_cell = stats_table.find(".graph-val-95percentile");

        // fill the stats
        if(stats.total || total_cell.is(':visible'))
          total_cell.show().find("span").html(tot_formatter(stats.total));
        if(stats.average || average_cell.is(':visible'))
          average_cell.show().find("span").html(stats_formatter(stats.average));
        if(stats.min_val || min_cell.is(':visible'))
          min_cell.show().find("span").html(stats_formatter(stats.min_val) + " @ " + (new Date(res[0].values[stats.min_val_idx][0] * 1000)).format(datetime_format));
        if(stats.max_val || max_cell.is(':visible'))
          max_cell.show().find("span").html(stats_formatter(stats.max_val) + " @ " + (new Date(res[0].values[stats.max_val_idx][0] * 1000)).format(datetime_format));
        if(stats["95th_percentile"] || perc_cell.is(':visible')) {
          perc_cell.show().find("span").html(stats_formatter(stats["95th_percentile"]));

          var values = makeFlatLineValues(data.start, data.step, data.count, stats["95th_percentile"]);

          res.push({
            key: graph_i18n["95_perc"],
            yAxis: 1,
            values: values,
            type: "line",
            classed: "line-dashed line-animated",
            color: "#476DFF",
            legend_key: "95perc",
            disabled: isLegendDisabled("95perc", true),
          });
        }

        // check if there are visible elements
        //if(stats_table.find("td").filter(function(){ return $(this).css("display") != "none"; }).length > 0)
      }
      stats_table.show();

      var enabled_series = res.filter(function(d) { return(d.disabled !== true); });

      if(second_axis_series.length > 0 || enabled_series.length == 0) {
        // Enable all the series
        for(var i=0; i<res.length; i++)
          res[i].disabled = false;
      }

      if(second_axis_series.length > 0) {
        // Don't allow series toggle by disabling legend clicks
        chart.legend.updateState(false);
      }

      update_chart_data(res);
      first_time_loaded = false;
    }).fail(function(xhr, status, error) {
      if (xhr.statusText =='abort') {
        return;
      }

      console.error("Error while retrieving the timeseries data [" + status + "]: " + error);
      update_chart_data([]);
    });

    if(first_load) {
      first_load = false;
    } else {
      var flows_dt = $("#chart1-flows");

      /* Reload datatable */
      if(flows_dt.data("datatable"))
        updateGraphsTableView(null, params);
    }

    if(typeof on_load_callback === "function")
      on_load_callback(chart);

    return true;
  }
}

var graph_old_view = null;
var graph_old_has_nindex = null;
var graph_old_nindex_query = null;

function tsQueryToTags(ts_query) {
  return ts_query.split(",").
    reduce(function(params, value) {
      var pos = value.indexOf(":");

      if(pos != -1) {
        var k = value.slice(0, pos);
        var v = value.slice(pos+1);
        params[k] = v;
      }

      return params;
  }, {});
}

function updateGraphsTableView(view, graph_params, has_nindex, nindex_query, per_page) {
  if(view) {
    graph_old_view = view;
    graph_old_has_nindex = has_nindex;
    graph_old_nindex_query = nindex_query;
  } else {
    view = graph_old_view;
    has_nindex = graph_old_has_nindex;
    nindex_query = graph_old_nindex_query;
  }

  var graph_table = $("#chart1-flows");
  nindex_query = nindex_query + "&begin_time_clause=" + graph_params.epoch_begin + "&end_time_clause=" + graph_params.epoch_end
  var nindex_buttons = "";
  var params_obj = tsQueryToTags(graph_params.ts_query);

  // TODO localize

  /* Hide IP version selector when a host is selected */
  if(!params_obj.host) {
    nindex_buttons += '<div class="btn-group"><button class="btn btn-link dropdown-toggle" data-toggle="dropdown">';
    nindex_buttons += "IP Version";
    nindex_buttons += '<span class="caret"></span></button><ul class="dropdown-menu" role="menu">';
    nindex_buttons += '<li><a href="#" onclick="return onGraphMenuClick(null, 4)">4</a></li>';
    nindex_buttons += '<li><a href="#" onclick="return onGraphMenuClick(null, 6)">6</a></li>';
    nindex_buttons += '</span></div>';
  }

  nindex_buttons += '<div class="btn-group pull-right"><button class="btn btn-link dropdown-toggle" data-toggle="dropdown">';
  nindex_buttons += "Explorer";
  nindex_buttons += '<span class="caret"></span></button><ul class="dropdown-menu" role="menu">';
  nindex_buttons += '<li><a href="'+ http_prefix +'/lua/enterprise/nindex_topk.lua'+ nindex_query +'">Top-K</a></li>';
  nindex_buttons += '<li><a href="'+ http_prefix +'/lua/enterprise/nindex.lua'+ nindex_query +'">Flows</a></li>';
  nindex_buttons += '</span></div>';

  if(view.columns) {
    var url = http_prefix + (view.nindex_view ? "/lua/enterprise/get_nindex_flows.lua" : "/lua/enterprise/get_ts_table.lua");

    var columns = view.columns.map(function(col) {
      return {
        title: col[1],
        field: col[0],
          css: {
	      textAlign: col[2], width: col[3],//
	  },
        hidden: col[4] ? true : false,
      };
    });

    columns.push({
      title: i18n.actions,
      field: "drilldown",
      css: {width: "1%", "white-space": "nowrap", "text-align": "center"},
    });

    /* Force reinstantiation */
    graph_table.removeData('datatable');
    graph_table.html("");

    graph_table.datatable({
      title: "",
      url: url,
      perPage: per_page,
      post: function() {
        var params = $.extend({}, graph_params);
        delete params.ts_compare;
        delete params.initial_point;
        params.limit = 1; // TODO make specific query
        // TODO change topk
        // TODO disable statistics
        params.detail_view = view.id;

        return params;
      },
      loadingYOffset: 40,
      columns: columns,
      buttons: view.nindex_view ? [nindex_buttons, ] : [],
      tableCallback: function() {
        var data = this.resultset;
        var stats_div = $("#chart1-flows-stats");
        var has_drilldown = (data && data.data.some(function(row) { return row.drilldown; }));

        /* Remove the drilldown column if no drilldown is available */
        if(!has_drilldown)
          $("table td:last-child, th:last-child", graph_table).remove();

        if(data && data.stats && data.stats.loading_time) {
           $("#flows-load-time").html(data.stats.loading_time);
           $("#flows-processed-records").html(data.stats.num_records_processed);
           stats_div.show();
        } else
          stats_div.hide();
      }, rowCallback: function(row, row_data) {
        if((typeof row_data.tags === "object") && (
          (params_obj.category && (row_data.tags.category === params_obj.category)) ||
          (params_obj.protocol && (row_data.tags.protocol === params_obj.protocol))
        )) {
          /* Highlight the row */
          row.addClass("info");
        }

        return row;
      }
    });
  }
}
