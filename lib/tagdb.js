/*
Copyright 2014 Charles Weissman

This file is part of "Vytroncs HMI, the 100% Free, Open-Source SCADA/HMI Initiative"
herein referred to as "Vytronics HMI".

Vytronics HMI is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

Vytronics HMI is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with Vytronics HMI.  If not, see <http://www.gnu.org/licenses/>.
*/

//This module implements the Tags database singleton
//
//Events emitted
//==============================
//tagdb.tagChanged(id, changeData) - Emitted everytime a tag changes.
//Note that when a client subscribes to a tag change the server will (if the
//client desires) refresh with the current tag data. This event is only for
//actual changes.
//
//  id = ID of the tag that changed
//  data = Change data object containing one property (key) for each data
//  that has changed. For example if only the value has changed:
//      { value: <new value }
//  If the value and another app defined field such as"stateText" has changed:
//      { value: <new value>, stateText:<some text> }
//

var vyutil = require("./vyutil");
var events = require("events");
var db = require("./db");
var log = require('log4js').getLogger('tagdb');
log.setLevel(vyutil.getenv('VYTRONICS_TAGDB_LOG_LEVEL', 'warn'));


module.exports.version = '0.0.0';
		
//TagDB can emit events
var emitter = new events.EventEmitter();

var globals = {};

var tags = {};

var TAG_TYPES = {
    DISCRETE: 'discrete',
    ANALOG: 'analog',
    UNTYPED: 'untyped',
    OBJECT: 'object'
};

//Load tags from json file
var load = function (json) {
	if ( undefined === json ) {
		return;
	}
		
	for( var tagid in json ) { 
		if( json.hasOwnProperty(tagid ) ) {
            
            //sys.* is reserved
            if (/^sys\..*/.exec(tagid)){
                log.error('tagdb load sys.* is a reserved tag id pattern.');
                continue;
            }
            
            var tag_config = json[tagid];
            
            //If no tag create function supplied then simply create a tag from json
            if (!tag_config.create) {
                tags[tagid] = new Tag(tagid,json[tagid]);
            }
            
            //Else - Execute the creation function which should spit out either a single tag_config literal
            //  {   tagid: "some_id",
            //      config: { }
            //  }
            //or an array of literals like the above
            else if ( vyutil.isFunction(tag_config.create) ){
                tag_config = tag_config.create(tagid, tag_config.config);

                tag_config = Array.isArray(tag_config) ? tag_config: [tag_config];

                tag_config.forEach( function (tag_info){
                    if ((!tag_info) || (!tag_info.tagid)) {
                        log.error('tagid:' + tagid + ' create error. Invalid config info. Must return {tagid:xxx,  config:xxx} config:', tag_info);
                    }
                    else {
                        tags[tag_info.tagid] = new Tag(tag_info.tagid, tag_info.config);
                    }
                });
            }
            else {
                log.error('tagid:' + tagid + ' create error. Invalid config:', tag_config);
            }
		}
	}
    
    emitter.emit('loaded');
};

//TODO - exposed this for sysdriver to create system tags
//Need more work to make it general and ensure other useages
//properly link up to drivers and get post load processing
//Also need to do more validation such as duplicate tags etc.
module.exports.create_tag = function(tagid, config) {
    var tag = new Tag(tagid, config);
    tags[tagid] = tag;
}

var start = function() {
	//Kick off any periodic calculations
	//TODO - how about a stop function
			
	getTags().forEach( function(tagid) {
		var tag = getTag(tagid);
	
		if (tag.calc) { //If this tag is a periodic calc
			if(tag.calc.intervalID) { //If already has an active timer
				clearInterval(tag.calc.intervalID);
			}
			setInterval( function() {
				try {
					var val = tag.calc.func.call(tag);
					tag.setValue(val);
				}
				catch(err){
					//TODO - log this
					log.error("Tag:"+tag.id+" calcVal error:" + err.message, err.stack);
				}
			}, tag.calc.interval);
		}
	});
};

var getTags = function() {
	var tagIds = [];
	for( var tid in tags ) {
		if ( tags.hasOwnProperty(tid) ) {
			tagIds.push(tid);
		}
	}
	return tagIds;
};

/*
If tagid begins with "regex:" then return array of matches, otherwise
returns single match
*/
var getTag = function (tagid) {
    
    var tag = tags[tagid];
    if (tag) return tag;
        
    return undefined;
};


var getTagsRegex = function (tagid_regex){
    
    var matches = [];

    Object.getOwnPropertyNames(tags).forEach( function(tagid){
        if (tagid.match(tagid_regex)) {
            matches.push(tags[tagid]);
        }
    });

    return matches;
    
};

var getTagInfo = function (tagid_regex, props){
    var matches = [];
    
    Object.getOwnPropertyNames(tags).forEach( function(tagid){
        if (tagid.match(tagid_regex)) {
            
            //If no specific properties requested then just send back tagids array
            if ( !props){
                matches.push(tagid);
            }
            else {
                var tag = tags[tagid];
                var tag_props = { tagid: tagid };
                props.forEach(function (prop){
                    if ( vyutil.isDefined(tag[prop]) ){
                        tag_props[prop] = tag[prop];
                    }
                });
                matches.push(tag_props);
            }
        }
    });
    
    return matches; 
};

module.exports.get_tag_types = function (){
    //make immutable by returning a copy
    return TAG_TYPES.slice();
}

module.exports.load = load;
module.exports.start = start;
module.exports.on = function (type, listener){ emitter.on(type, listener); },
module.exports.getTags = getTags;
module.exports.getTag = getTag;
module.exports.getTagInfo = getTagInfo;
module.exports.getTagsRegex = getTagsRegex;

//Ask driver to write a value to this tagid. This is typically called from a client
//GUI and value may need to be coerced according to tag.value_info to expected telemetry
//value
//
module.exports.write_tag_request = function (tagid, value) {
    
    var tag = getTag(tagid);
        
    //Coerce value if necessary to telemetry value
    value = tag.coerce_value(value);
    
console.log('###tagdb write_tag tagid:' + tagid + ' value:' + value);    
    
    db.driverdb.write_item(tag.driverinfo, value);
    
    return true;
}

	
////////////////Private Tag class. Nobody should be constructing outside this module	
//Construct a Tag object from json
//Subscribe to driver IO and kick off any periodic calc loops
function Tag(tagid, json) {
	
	this.id = tagid;
	this.value = json.defaultValue;
    
    //Assign to mem driver if no driver info
	this.driverinfo = json.driverinfo || { id:'mem', item:tagid};
    
    //The value_info object gives tags their personality. Provides the information for converting raw
    //telemetered values to the desired engineering values (or discrete states) and visa versa. Also
    //associcates alarm priority as desired. If no convert object defined then no conversion is performed
    //from or to telemetry value. May change in the future to use default value as a hint.
    //
    //  For discrete tags...
    //  value_info: {
    //      type: "discrete",
    //      map: [  { value: 0, state: "NORMAL", almprior: 0 },
    //              { value: 1, state: "ALARM", almprior: 3 } ],
    //      comment: "can put a string here for GUIs"
    //  }
    //
    //  For analog tags...
    //  value_info: {
    //      type: "analog",
    //      to_daq: !!js/function "function(value) { return value*10 - 3; }",
    //      from_daq: !!js/function "function(volts) { return (volts + 3) / 10; }",
    //      min: -30,
    //      max: 100,
    //      //Need something for alarms TODO
    //      comment: "can put a string here for guis"
    //  }
    //          
    //
    //  TODO - validate
    this.value_info = json.value_info;
    
    
	//Set up any periodic calcs
	if( json.calcVal !== undefined ) {
		
        this.calc ={ interval:json.calcVal.interval, //TODO - test isNaN
                    func:json.calcVal.func
                };
		
	}    
}

//Set the tag value and send notifications. Converts from raw telemetry to HMI value
//If tag.value_info object is defined then this info is used to value_info
//  to/from raw telemetry value. Otherwise try to coerce to number.
//  
//  value is the raw telemetry value
//
//  Precondition - tag.value_info has been validated when DB was loaded
//
Tag.prototype.setValue = function(value) {

    //TODO - should function check for no change in value
    //and if so exit with no action?
    
    if ( ! vyutil.isDefined(this.value_info) || (this.value_info.type === TAG_TYPES.UNTYPED)) {
        //Attempt to coerce to number
        var tagval = +value;
        tagval = isNaN(tagval) ? value : tagval;
        this.value = tagval;
    }
    else if (this.value_info.type === TAG_TYPES.OBJECT) {
        log.warn('TODO - implement analog tag types.');
        //Coerce JSON strings to objects?
        this.value = value;
    }
    else if (this.value_info.type === TAG_TYPES.DISCRETE){
        var map = this.value_info.map;
        var mapval = undefined;
        for (var i=0; i<map.length; i++){
            if (map[i].value === value){
                mapval = map[i].state;
                break;
            }
        }
        
        if ( ! vyutil.isDefined(mapval) ){
            log.error('attempt to set invalid value [' + value + '] for tag ' + this.id);
            return;
        }
        else {
            this.value = mapval;
        }
    }
    else if (this.value_info.type === TAG_TYPES.ANALOG){
        value = +value;
        if (isNaN(value)) return; //TODO log error?
        
        var from_daq = this.value_info.from_daq;
        if ( from_daq ) { //If conversion is defined, do it
            value = from_daq(value);
            
            //TODO - test min and max if limits are defined
            this.value = value;
        }        
    }

    var data = {
        //TODO - pass other properties such as quality, alarm priority etc.
        id: this.id,
        value: this.value
    };
	emitter.emit("tagChanged", this.id, data);
};

//Coerce to and return raw telemetry value
//
Tag.prototype.coerce_value = function (value){
  
    if ( ! vyutil.isDefined(this.value_info) || (this.value_info.type === TAG_TYPES.UNTYPED)) {
        //Attempt to coerce to number
        var tagval = +value;
        tagval = isNaN(tagval) ? value : tagval;
        return tagval;
    }
    else if (this.value_info.type === TAG_TYPES.OBJECT) {
        //TODO - this is wrong. Driver should expect a JSON string or plain string
        //The logic below would be needed for in memory tags. Think about it.
        //If string try to coerce from JSON
        if (vyutil.isString(value)){
            try {
                return JSON.parse(value);
            } catch(err) {
                //Let value just be the string
                return value;
            } 
        }
        else {
            return value;
        }
    }
    else if (this.value_info.type === TAG_TYPES.DISCRETE){
        //Reverse lookup from state string to value
        var map = this.value_info.map;
        var telemval = undefined;
        for (var i=0; i<map.length; i++){
            if (map[i].state === value){
                telemval = map[i].value;
                break;
            }
        }
        if ( ! vyutil.isDefined(telemval) ){
            log.error('attempt to coerce invalid value [' + value + '] for tag ' + this.id);
            return undefined;
        }
        else {
            return telemval;
        }
    }
    else if (this.value_info.type === TAG_TYPES.ANALOG){
        value = +value;
        if (isNaN(value)) return; //TODO log error?
        
        var to_daq = this.value_info.to_daq;
        if ( to_daq ) { //If conversion is defined, do it
            value = to_daq(value);
            
            //TODO - test min and max if limits are defined
            return value;
        }        
        
    }
    else {
        log.warn('tag.coerce_value programmer error tag:' + this.id + '?');
    }

};


/*
Return a safe copy of value_info for tag

    For discretes: {
        type: "discrete",
        states: [] - array of valid state strings
        comment: string for GUIs
    }
    
    For analog: {
        type: "analog",
        min:    min reasonability limit
        max:    max reasonability limit
        comment: string for GUIs
    }
    
    For object type: {
        type: "object",
        comment: string for GUIs
    }
    
    For tags with no value_info object: {
        type: 'untyped',
        comment: - will be a system generated string
        "Untyped. Attempt will be made too coerce telemetry values to numbers."
    }

*/
Tag.prototype.get_value_info = function (){
    if ( ! vyutil.isDefined(this.value_info) ) {
        return {
            type: TAG_TYPES.UNTYPED,
            comment: "Untyped tag. Attempt will be made to coerce telemetry values to numbers."
        };
    }
    else if (this.value_info.type === TAG_TYPES.UNTYPED){
        return {
            type: TAG_TYPES.UNTYPED,
            comment: this.value_info.comment || "Untyped tag. Attempt will be made to coerce telemetry values to numbers."
        };
    }
    else if (this.value_info.type === TAG_TYPES.DISCRETE){
        var map = this.value_info.map;
        var states = [];
        this.value_info.map.forEach( function (mapi){
            states.push(mapi.state);
        });
        
        return {
            comment: this.value_info.comment || "discrete tag type",
            states: states
        };
    }
    else if (this.value_info.type === TAG_TYPES.ANALOG){
        return {
            min: this.value_info.min,
            max: this.value_info.max,
            num_digits: this.value_info.num_digits,
            comment: this.value_info.comment || "analog tag type"
        };
    }
    else if (this.value_info.type === TAG_TYPES.OBJECT){
        return {
            comment: this.value_info.comment || "object tag type"
        };
    }
};
