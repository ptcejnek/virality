#!/bin/env node
//  OpenShift sample Node application
var express = require('express');
var fs      = require('fs');
var mongodb = require('mongodb');
var CronJob = require('cron').CronJob;
var FeedParser = require('feedparser'), request = require('request');
var moment = require('moment-timezone');


var rss_feeds = [
    'http://idnes.cz.feedsportal.com/c/34387/f/625936/index.rss',
    'http://www.parlamentnilisty.cz/export/rss.aspx',
    'http://servis.lidovky.cz/rss.aspx?r=ln_domov',
    'http://servis.lidovky.cz/rss.aspx?r=ln_zahranici',
    'http://servis.lidovky.cz/rss.aspx?r=ln_nazory',
    'http://zpravy.aktualne.cz/rss/',
    'http://nazory.aktualne.cz/rss/',
    'http://www.blesk.cz/rss',
    'http://www.rozhlas.cz/zpravy/rss_zahranici',
    'http://www.rozhlas.cz/zpravy/rss_domaci',
    'http://www.rozhlas.cz/zpravy/rss_komentare',
    'http://blisty.cz/rss2.rb',
    'http://svobodnenoviny.eu/feed/',
    'http://www.reflex.cz/rss',
    'http://ihned.cz/?m=rss',
    'http://www.tyden.cz/rss/rss.php?all'
];


var head =  
    '<html>'+
        '<head>'+
            '<meta charset="utf-8">'+
            '<title>Virality</title>'+
            '<style>'+
            '#total a,.title a{text-decoration:none}.block,.left{float:left}body{font-family:arial,sans-serif;padding:40px}.clear{clear:both}'+
            '#total{padding-bottom:20px;border-bottom:1px dotted silver;margin-bottom:20px}#total a{color:#4ba3d9;margin-left:5px}'+
            '#filtered_by{padding-bottom:30px}.article{color:#444;font-size:13px;line-height:15px;margin-bottom:25px}'+
            '.title a{color:#4ba3d9;font-weight:700}.block{display:block;width:50px}.timestamp{color:#a7a7a7}'+
            '</style>'+
        '</head>'+
        '<body>';


/**
 *  Define the sample application.
 */
var MyApp = function() {

    //  Scope.
    var self = this;


    /*  ================================================================  */
    /*  Helper functions.                                                 */
    /*  ================================================================  */

    /**
     *  Set up server IP address and port # using env variables/defaults.
     */
    self.setupVariables = function() {
        //  Set the environment variables we need.
        self.ipaddress = process.env.OPENSHIFT_NODEJS_IP;
        self.port      = process.env.OPENSHIFT_NODEJS_PORT || 8080;

        if (typeof self.ipaddress === "undefined") {
            //  Log errors on OpenShift but continue w/ 127.0.0.1 - this allows us to run/test the app locally.
            console.warn('No OPENSHIFT_NODEJS_IP var, using 127.0.0.1');
            self.ipaddress = "127.0.0.1";
        }

        // MongoDB
        self.mongodb_host = process.env.OPENSHIFT_MONGODB_DB_HOST || "127.0.0.1";
        self.mongodb_port = process.env.OPENSHIFT_MONGODB_DB_PORT || "27017";
        self.app_name = process.env.OPENSHIFT_APP_NAME || "cz";


        self.dbServer = new mongodb.Server(self.mongodb_host, parseInt(self.mongodb_port, 10));
        self.db = new mongodb.Db(self.app_name, self.dbServer, {auto_reconnect: true});
        self.dbUser = process.env.OPENSHIFT_MONGODB_DB_USERNAME || "honzzz";
        self.dbPass = process.env.OPENSHIFT_MONGODB_DB_PASSWORD || "lclpwd";
    };


    /**
     *  Populate the cache.
     */
    self.populateCache = function() {
        if (typeof self.zcache === "undefined") {
            self.zcache = { 'index.html': '' };
        }

        //  Local cache for static content.
        self.zcache['index.html'] = fs.readFileSync('./static/index.html');
        self.zcache['d3-cloud.js'] = fs.readFileSync('./static/d3-cloud.js');
    };


    /**
     *  Retrieve entry (content) from cache.
     *  @param {string} key  Key identifying content to retrieve from cache.
     */
    self.cache_get = function(key) { return self.zcache[key]; };


    /**
     *  terminator === the termination handler
     *  Terminate server on receipt of the specified signal.
     *  @param {string} sig  Signal to terminate on.
     */
    self.terminator = function(sig){
        if (typeof sig === "string") {
           console.log('%s: Received %s - terminating sample app...', Date(Date.now()), sig);
           process.exit(1);
        }
        console.log('%s: Node server stopped.', Date(Date.now()));
    };


    /**
     *  Setup termination handlers (for exit and a list of signals).
     */
    self.setupTerminationHandlers = function(){
        //  Process on exit and signals.
        process.on('exit', function() { self.terminator(); });

        // Removed 'SIGPIPE' from the list - bugz 852598.
        ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
         'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
        ].forEach(function(element, index, array) {
            process.on(element, function() { self.terminator(element); });
        });
    };


    /*  ================================================================  */
    /*  App server functions (main app logic here).                       */
    /*  ================================================================  */

    /**
     *  Create the routing table entries + handlers for the application.
     */
    self.createRoutes = function() {
        self.routes = {};

        self.routes['/static'] = function(req, res) {
            res.setHeader('Content-Type', 'text/html');
            res.send(self.cache_get('index.html'));
        };

        self.routes['/d3-cloud.js'] = function(req, res) {
            res.setHeader('Content-Type', 'text/javascript');
            res.send(self.cache_get('d3-cloud.js'));
        };

        self.routes['/'] = function(req, res) {

            // read from db, sorted by ID in reverse order
            self.db.collection('virality').find({}, null, {sort: {'_id': -1}}).toArray(function(err, items) {

                res.setHeader('Content-Type', 'text/html');

                var total = '<div id="total"><strong><a href="/">'+Object.keys(items).length+'</a></strong> článků &nbsp;|&nbsp; '+
                        'nejvíce: <a href="/?most=like">likes</a> <a href="/?most=share">shares</a>'+
                        ' <a href="/?most=comment">comments</a> <a href="/?most=tweet">tweets</a>'+
                        '</div>';

                // filtering
                if (req.query.most) {
                    total = total+'<div id="filtered_by">Top 10 článků s nejvíce <strong>'+req.query.most+'s</strong></div>';

                    // sort in ascending order
                    items.sort(function(a, b) {
                        return a.checks[a.checks.length-1][req.query.most+'_count'] - b.checks[b.checks.length-1][req.query.most+'_count'];
                    });

                    // get only 100 most important words and adjust size so the biggest words fit to screen
                    var top_10 = [];
                    for (var i = items.length-1; i > items.length-10; i--) {
                        top_10.push(items[i]);
                    }
                    items = top_10;

                }

                var articles = '', last_check, counter = 0;
                for (var i in items) {

                    //if (true) {
                    if (counter < 100) { // 100 newest articles
                        counter++;

                        last_check = items[i].checks.length-1;

                        var first_check_t = moment(items[i].checks[0].timestamp);
                        var last_check_t = moment(items[i].checks[last_check].timestamp);

                        // based on http://stackoverflow.com/a/13904120/716001
                        var convertSeconds = function(earlier, later) {
                            var result = '';

                            // get total seconds between the times
                            var delta = Math.abs(later - earlier);

                            // calculate (and subtract) whole days
                            var days = Math.floor(delta / 86400);
                            delta -= days * 86400;

                            // calculate (and subtract) whole hours
                            var hours = Math.floor(delta / 3600) % 24;
                            delta -= hours * 3600;

                            if (days > 0) {
                                result = days+'d ';
                            }
                            if (hours > 0) {
                                result = result+hours+'h ';
                            }

                            return result;
                        };
                        var diff = convertSeconds(first_check_t.format('X'), last_check_t.format('X'));

                        // get domain name 
                        var dn = items[i].url.split('/')[2];

                        articles = articles+'<div class="article">'+dn+'<div class="title"><a href="'+items[i].url+'">'+items[i].title+'</a></div>'+
                        '<div class="shares"><span class="left">likes:&nbsp;</span><span class="block">'+items[i].checks[last_check].like_count+
                        '</span><span class="left">shares:&nbsp;</span><span class="block">'+items[i].checks[last_check].share_count+
                        '</span><span class="left">comments:&nbsp;</span><span class="block">'+items[i].checks[last_check].comment_count+
                        '</span><span class="left">tweets:&nbsp;</span><span class="block">'+items[i].checks[last_check].tweet_count+
                        '</span><span class="left timestamp">'+first_check_t.tz('Europe/Prague').format("DD/MM/YYYY HH:mm")+
                        '</span><span class="left timestamp">&nbsp;&nbsp;&nbsp;'+last_check_t.tz('Europe/Prague').format("DD/MM/YYYY HH:mm")+
                        '</span><span class="left timestamp">&nbsp;&nbsp;&nbsp;'+diff+
                        '</span></div><div class="clear"></div></div>';
                    }
                }

                var foot =
                        '</body>'+
                    '</html>';

                res.send(head+total+articles+foot);
            });
        };

        self.routes['/wordcloud'] = function(req, res) {

            // read from db
            self.db.collection('virality').find().toArray(function(err, items) {

                res.setHeader('Content-Type', 'text/html');

                var wordcloud = '', last_check;
                for (var i in items) {
                    if (items[i].title) {
                        last_check = items[i].checks.length-1;

                        var last_count = items[i].checks[last_check][req.query.count+'_count'];

                        var title = items[i].title;

                        // remove unwanted words
                        var unwanted = /^(a|až|už|k|ať|by|s|v|ve|jsou|je|u|za|ze|z|od|do|pro|si|kde|aby|to|má|o|i|ani|jen|se|na|ho|bylo)$/, cleaned = '';
                        title.split(' ').forEach(function(word) {
                            if (!unwanted.test(word.toLowerCase())) {
                                cleaned = cleaned+'#'+word;
                            }
                        });

                        var title_weighted = '';

                        for (var i = 0; i < last_count; i++) {
                            title_weighted = title_weighted+cleaned;
                        }

                        wordcloud = wordcloud+title_weighted;
                    }
                }

                // strip commas and dots
                wordcloud = wordcloud.replace(/[,.:]/g, '');

                // count occurrences of each word in string of titles multiplied by likes
                // based on http://stackoverflow.com/a/14914165/716001
                var counts = wordcloud.split('#').reduce(function(map, word){
                    map[word] = (map[word]||0)+1;
                    return map;
                }, Object.create(null));
                // outputs {{"word": 22}, ...}

                // reformat data for d3-cloud
                var data_4_d3cloud = [], c;
                for (c in counts) {
                    data_4_d3cloud.push({"text": c, "size": counts[c]});
                };
                // outputs [{"text": "word", "size": 22}, ...]

                // sort in ascending order
                data_4_d3cloud.sort(function(a, b) {
                    return a.size - b.size;
                });

                // get only 100 most important words and adjust size so the biggest words fit to screen
                var data_4_d3cloud_top = [];
                var highest_size = data_4_d3cloud[data_4_d3cloud.length-1].size;
                for (var i = data_4_d3cloud.length-1; i > data_4_d3cloud.length-100; i--) {
                    var calculated_size = data_4_d3cloud[i].size/(highest_size/100) || 0;
                    if (calculated_size > 10) {
                        data_4_d3cloud_top.push({"text": data_4_d3cloud[i].text, "size": calculated_size});
                    }
                };

                var d3cloud = 
                    '<script src="//cdnjs.cloudflare.com/ajax/libs/d3/3.5.6/d3.min.js"></script>'+
                    '<script src="./d3-cloud.js"></script>'+
                    '<script>(function() {'+
                        'var fill = d3.scale.category20();'+
                        'var layout = d3.layout.cloud().size([1400, 800]).words('+
                            JSON.stringify(data_4_d3cloud_top)+
                            ').padding(6).rotate(function() { return ~~(Math.random() * 1) * 0; }).font("Arial")'+
                            '.fontSize(function(d) { return d.size; }).on("end", draw);'+
                        'layout.start();'+
                        'function draw(words) {'+
                          'd3.select("body").append("svg")'+
                              '.attr("width", layout.size()[0])'+
                              '.attr("height", layout.size()[1])'+
                              '.append("g")'+
                              '.attr("transform", "translate(" + layout.size()[0] / 2 + "," + layout.size()[1] / 2 + ")")'+
                              '.selectAll("text")'+
                              '.data(words)'+
                              '.enter().append("text")'+
                              '.style("font-size", function(d) { return d.size + "px"; })'+
                              '.style("font-family", "Arial")'+
                              '.style("fill", function(d, i) { return fill(i); })'+
                              '.attr("text-anchor", "middle")'+
                              '.attr("transform", function(d) {'+
                                'return "translate(" + [d.x, d.y] + ")rotate(" + d.rotate + ")";'+
                              '})'+
                              '.text(function(d) { return d.text; });'+
                        '}'+
                    '})();</script>';

                var foot =
                        '</body>'+
                    '</html>';

                res.send(head+d3cloud+foot);
                //res.send(head+JSON.stringify(data_4_d3cloud_top)+foot);
            });
        };
    };


    /**
     *  Initialize the server (express) and create the routes and register
     *  the handlers.
     */
    self.initializeServer = function() {
        self.createRoutes();
        self.app = express();

        //  Add handlers for the app (from the routes).
        for (var r in self.routes) {
            self.app.get(r, self.routes[r]);
        }
    };


    /**
     *  Initializes the sample application.
     */
    self.initialize = function() {
        self.setupVariables();
        self.populateCache();
        self.setupTerminationHandlers();

        // Create the express server and routes.
        self.initializeServer();
    };


    // Logic to open a database connection. We are going to call this outside of app so it is available to all our functions inside.
    self.connectDb = function(callback){
        self.db.open(function(err, db){
            if (err) { throw err }
            self.db.authenticate(self.dbUser, self.dbPass, {authdb: "admin"},  function(err, res){
                if (err) { throw err }
                callback();
            });
        });
    };


    /**
     *  Start the server (starts up the sample application).
     */
    self.start = function() {
        //  Start the app on the specific interface (and port).
        self.app.listen(self.port, self.ipaddress, function() {
            console.log('%s: Node server started on %s:%d...', Date(Date.now()), self.ipaddress, self.port);

            var loop_running;

            // run cron
            new CronJob('* * * * *', function(){ // every minute
            //new CronJob('0 * * * *', function(){ // every hour

                var d = new Date();
                var m = d.getMinutes();
                var h = d.getHours();

                // check one feed every minute
                if (rss_feeds[m]) {console.log(rss_feeds[m], 'feed checked');

                    /*
                    get RSS feed
                    */

                    var req = request(rss_feeds[m]), feedparser = new FeedParser();

                    req.on('error', function (error) {
                        console.log('req', error); 
                    });
                    req.on('response', function (res) {
                        var stream = this;

                        if (res.statusCode != 200) {
                            return this.emit('error', new Error('Bad status code'));
                        }

                        stream.pipe(feedparser);
                        return 1;
                    });

                    feedparser.on('error', function(error) {
                        console.log('feedparser', error);
                    });
                    feedparser.on('readable', function() {
                        var stream = this,
                            meta = this.meta, // **NOTE** the "meta" is always available in the context of the feedparser instance 
                            item;

                        while (item = stream.read()) {

                            var url = item.link;

                            // remove unnecessary URL params if there are any
                            if (url.indexOf('#') !== -1) {
                                url = url.substr(0, url.indexOf('#'));
                            }

                            self.db.collection('urls').update({'url': url}, {'url': url, 'title': item.title}, {upsert: true});
                        }
                    });
                }

                // start every two hours (odd hours)
                if (!m && h % 2) {

                    /*
                    get virality info for all stored URLs
                    every hour in delayed loop that ticks once per second
                    */

                    self.db.collection('urls').find().toArray(function(err, items) {

                        var getViralityData = function(item) {

                            if (!item.title) {
                                item.title = 'bez titulku';
                            }

                            // data to insert into db
                            var data = {
                                'title': item.title,
                                'url': item.url
                            };

                            // get Facebook likes and shares and tweets
                            var encoded_url = encodeURIComponent(data.url);
                            var fb_graph_req = 
                            "https://graph.facebook.com/fql?q=SELECT url, share_count, like_count, comment_count "+
                            "FROM link_stat WHERE url='"+encoded_url+"'";

                            request(fb_graph_req, function (error, response, body) {
                                if (!error && response.statusCode == 200) {
                                    var facebook_data = JSON.parse(body).data[0];

                                    var tweets_req = 'http://urls.api.twitter.com/1/urls/count.json?url='+encoded_url;

                                    request(tweets_req, function (error, response, body) {
                                        if (!error && response.statusCode == 200) {

                                            var check = {
                                                'timestamp': moment().toISOString(),
                                                'like_count': facebook_data.like_count,
                                                'share_count': facebook_data.share_count,
                                                'comment_count': facebook_data.comment_count,
                                                'tweet_count': JSON.parse(body).count
                                            };

                                            // insert data into db
                                            self.db.collection('virality').update(data, {$addToSet: {'checks': check}}, {upsert: true});
                                        }
                                    });
                                }
                            });
                        };

                        var items_to_check = [];
                        for (var j in items) {

                            // check how old item is
                            var a = moment(items[j]._id.getTimestamp());
                            var b = moment();
                            how_old = b.diff(a, 'days');

                            // if NOT older than 3 days
                            if (how_old <= 3) {
                                items_to_check.push(items[j]);
                            }
                        }

                        // delayed loop
                        var myLoop = function(i) {          
                            setTimeout(function () {
                                getViralityData(items_to_check[i-1]);                
                                if (--i) {
                                    myLoop(i); // decrement i and call myLoop again if i > 0
                                }
                                else { // loop finished
                                    loop_running = 0; // marker signaling that loop can be started again
                                    console.log('Likes obtained at', moment().tz('Europe/Prague').toISOString()+',', items_to_check.length+' articles.');
                                }
                            }, 1100)
                        };

                        // if not already running
                        if (!loop_running) {
                            loop_running = 1;
                            myLoop(items_to_check.length);
                        }
                        else {
                            console.log('LOOP STILL RUNNING');
                        }
                    });
                }
            }, null, true);
            //self.db.collection('virality').remove({}, function(){console.log('Data removed - virality');});
            //self.db.collection('urls').remove({}, function(){console.log('Data removed - urls');});
        });
    };

};



/**
 *  main():  Main code.
 */
var app = new MyApp();
app.initialize();
app.connectDb(app.start);
