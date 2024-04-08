const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const tuya = require('zigbee-herdsman-converters/lib/tuya');
const utils = require('zigbee-herdsman-converters/lib/utils');
const e = exposes.presets;
const ea = exposes.access;
//const {Buffer} = require('buffer');

// 
// WARNING !!!! only tested on _TZE204_81yrt3lo
//

// The PJ1203A is sending quick sequence of messages containing a single datapoint.
// A sequence occurs every `update_frequency` seconds (10s by default) 
//
// A typical sequence is composed two identifcal groups for channel a and b. 
//
//     102 energy_flow_a
//     112 voltage
//     113 current_a
//     101 power_a
//     110 power_factor_a
//     111 ac_frequency
//     115 power_ab
//     ---
//     104 energy_flow_b
//     112 voltage
//     114 current_b
//     105 power_b
//     121 power_factor_b
//     111 ac_frequency
//     115 power_ab
//
// It should be noted that when no current is detected on channel x then
// energy_flow_x is not emited and current_x==0, power_x==0 and energy_flow_x==100.
// Simply speaking, energy_flow_x is optional but the case can easily be detected
// by checking if current_x or power_x is 0.
//
// The other datapoints are emitted every few minutes.  
// 


// Store our internal state in meta.device._priv
function PJ1203A_getPrivateState(meta) {
    if ( ! ('_priv' in meta.device) ) {
        meta.device._priv = {
            'sign_a': null, 
            'sign_b': null, 
            'power_a': null, 
            'power_b': null,
            'current_a': null,
            'current_b': null,
            'power_factor_a': null,
            'power_factor_b': null,
            'last_seq': -99999,
            'timestamp_a': null,
            'timestamp_b': null,
            // Also save the last published signed values of power_a and power_b
            // to recompute power_ab on the fly.
            'pub_power_a': null,
            'pub_power_b': null,            
        } ;
    }      
    return meta.device._priv ;
}

// The _TZE204_81yrt3lo increments its payload 'seq' value by steps of 256
// This is hopefully the same for all variants. 
const PJ1203A_SEQ_INCREMENT = 256 ; 

const PJ1203A_options = {
    
    energy_flow_qwirk: (x) => exposes.binary('energy_flow_qwirk_'+x.toUpperCase(), ea.SET, true, false )
        .withDescription(
            ' If true then delay channel '+x.toUpperCase()+' publication until the next energy flow update.'+
                ' The default is false.'
        ),

    signed_power: (x) => exposes.binary('signed_power_'+x.toUpperCase(), ea.SET, true, false )
        .withDescription(
            ' If true then power_'+x+' is signed otherwise the direction is provided by energy_flow_'+x+'.'+
                ' The default is false.'
        ),
};

function PJ1203A_get_energy_flow_qwirk(options,x) {
    let key ='energy_flow_qwirk_'+x.toUpperCase()  
    if (key in options) 
        return options[key]
    else
        false ;
}

function PJ1203A_get_signed_power(options,x) {
    let key ='signed_power_'+x.toUpperCase()  
    if (key in options) 
        return options[key]
    else
        false ;
}

// Recompute power_ab when power_a or power_b is published.
function PJ1203A_recompute_power_ab(result,priv,options) {

    let modified = false ;

    // Important: 'power_x' and 'energy_flow_x' must be published together
    
    if ( 'power_a' in result ) {        
        priv.pub_power_a = result.power_a * ( result.energy_flow_a == 'producing' ? -1 : 1 )  ;
        modified = true ;
    }
    if ( 'power_b' in result ) {
        priv.pub_power_b = result.power_b * ( result.energy_flow_b == 'producing' ? -1 : 1 )  ;
        modified = true ;
    }
    
    if (modified) {
        if ( priv.pub_power_a!==null &&
             priv.pub_power_b!==null ) {
            
            // Note: We need to "cancel" and reapply the scaling by 10
            //       because of annoying floating-point rounding errors.
            //       For example:
            //          79.8 - 37.1  --> 42.699999999999996
            result['power_ab'] = Math.round(10*priv.pub_power_a + 10*priv.pub_power_b) / 10 ;
        }
    }
}

function PJ1203A_flush_all(result,x,priv,options) {

    let sign         = priv['sign_'+x] ; 
    let power        = priv['power_'+x] ; 
    let current      = priv['current_'+x] ; 
    let power_factor = priv['power_factor_'+x] ;

    // Make sure that we use them only once. No obsolete data!!!!
    priv['sign_'+x] = priv['power_'+x] = priv['current_'+x] = priv['power_factor_'+x] = null ;

    // And only publish after receiving a complete set 
    if ( sign!==null && power!==null && current!==null && power_factor!==null ) {
        if ( PJ1203A_get_signed_power(options,x) ) {
            result['power_'+x]        = sign * power ;
            result['energy_flow_'+x]  = 'sign';

        } else {
            result['power_'+x]        =  power ;
            result['energy_flow_'+x]  = (sign>0) ? 'consuming' : 'producing' ;
        }
        result['timestamp_'+x]    = priv['timestamp_'+x];
        result['current_'+x]      = current;
        result['power_factor_'+x] = power_factor;
        PJ1203A_recompute_power_ab(result,priv,options);
        return true;
    }
    
    return false;
}

// When the device does not detect any flow, it stops sending 
// the energy_flow datapoint (102 and 104) and always set
// current_x=0, power_x=0 and power_factor_x=100.
//
// So if we see a datapoint with current==0 or power==0
// then we can safely assume that we are in that zero energy state.
//
function PJ1203A_flush_zero(result,x,priv,options) {
    priv['sign_'+x] = +1 ; 
    priv['power_'+x] = 0 ;
    priv['timestamp_'+x] = new Date().toISOString() ;
    priv['current_'+x] = 0 ;
    priv['power_factor_'+x] = 100 ;
    PJ1203A_flush_all(result,x,priv,options); 
}

const PJ1203A_valueConverters = {
    
    energy_flow: (x) =>  {
        return {
            from: (v, meta, options) => {
                let priv = PJ1203A_getPrivateState(meta) ;               
                let result = {} ;
                priv['sign_'+x] = (v==1) ? -1 : +1  ;
                let energy_flow_qwirk = PJ1203A_get_energy_flow_qwirk(options,x)
                if (energy_flow_qwirk) {
                    PJ1203A_flush_all(result, x, priv, options);
                    if ( 'updated_'+x in  result ) {
                    }
                }    
                return result;
            } 
        };
    }, // end of energy_flow:

    power: (x) => {
        return {
            from: (v, meta, options) => {

                let priv = PJ1203A_getPrivateState(meta) ;
                let result = {} ;
                let power_x =  v / 10.0 ;
                
                priv['power_'+x] = power_x;  
                priv['timestamp_'+x] = new Date().toISOString()
                
                if (v==0) {
                    PJ1203A_flush_zero(result, x, priv, options);
                    return result;
                }

                return result;
            }
        };
    },  // end of power:

    current: (x) => {
        return {
            from: (v, meta, options) => {

                let priv = PJ1203A_getPrivateState(meta) ;
                let result = {} ;
                let current_x = v / 1000.0 ;
                
                priv['current_'+x] = current_x ;  

                if (v==0) {
                    PJ1203A_flush_zero(result, x, priv, options);
                    return result;                    
                }
                
                return result;
            }
        };
    },  // end of current: 
    
    power_factor: (x) => {
        return {
            from: (v, meta, options) => {

                let priv = PJ1203A_getPrivateState(meta) ;
                let result = {} ;
                priv['power_factor_'+x] = v ;  

                let energy_flow_qwirk = PJ1203A_get_energy_flow_qwirk(options,x)
                if (!energy_flow_qwirk) {
                    PJ1203A_flush_all(result, x, priv, options); 
                }            
                return result;
            }
        };
    },  // end of power_factor: 


    // We currently discard the power_ab datapoint.
    // It is always recomputed on the fly to match
    // the published values or power_a and power_b 
    power_ab: () => {
        return {
            from: (v, meta, options) => {
                return {} ;
            }
        };
    },  // end of power_ab: 
    
};


//
// A customized version of fz.ignore_tuya_set_time
// that also increases our private 'next_seq' field.
//
// This is needed to prevent 'commandMcuSyncTime' from
// messing up with our detection of missing datapoints (see 
// below in PJ1203A_fz_datapoints).
//
const PJ1203A_ignore_tuya_set_time = {
    cluster: 'manuSpecificTuya',
    type: ['commandMcuSyncTime'],
    convert: (model, msg, publish, options, meta) =>
    {
        // There is no 'seq' field in the msg payload of 'commandMcuSyncTime'
        // but the device is increasing its counter. 
        let priv = PJ1203A_getPrivateState(meta) ;
        priv.last_seq += PJ1203A_SEQ_INCREMENT ;
    }
};

//
// This is basically tuya.fz.datapoints extended to detect missing
// or reordered messages.
//
const PJ1203A_fz_datapoints = {

    ...tuya.fz.datapoints,
    
    convert: (model, msg, publish, options, meta) => {

        let result = {}

        // Uncomment the next line to test the behavior
        // when random messages are lost 
        // if ( Math.random() < 0.05 ) return ;      
        
        let priv = PJ1203A_getPrivateState(meta) ;

        // Detect missing or re-ordered messages but allow duplicate messages.
        let expected_seq = (priv.last_seq+PJ1203A_SEQ_INCREMENT) & 0xFFFF ;
        if ( ( msg.data.seq != expected_seq ) && ( msg.data.seq != priv.last_seq ) )  {             
            meta.logger.debug(`[PJ1203A] Missing or re-ordered message detected: Got seq=${msg.data.seq}, expected ${priv.next_seq}`);
            // Clear all pending attributes 
            priv.sign_a = null;
            priv.sign_b = null;
            priv.power_a = null;
            priv.power_b = null;
            priv.current_a = null;
            priv.current_b = null;
            priv.power_factor_a = null;
            priv.power_factor_b = null;
        }
        
        priv.last_seq =  msg.data.seq;
        
        // Uncomment to display device data in the state (for debug)   
        // result['device'] = meta.device ;
        
        // And finally, process the dp with tuya.fz.datapoints 
        Object.assign( result, tuya.fz.datapoints.convert(model, msg, publish, options, meta) ) ;

        // WARNING: MUST BE REMOVED IN FINAL RELEASE
        // meta.logger.debug(`[PJ1203A] priv   = ${JSON.stringify(priv)}`);
        // meta.logger.debug(`[PJ1203A] result = ${JSON.stringify(result)}`);

        return result;
    }
};

const PJ1203A_tz_datapoints = {
    ...tuya.tz.datapoints,
    key: [ 'update_frequency' ]
};

const definition = {
    fingerprint: tuya.fingerprint('TS0601', [ '_TZE204_81yrt3lo', ]),
    model: 'PJ-1203A',
    vendor: 'TuYa',
    description: 'Bidirectional energy meter with 80A current clamp (CUSTOMIZED)',
    fromZigbee: [PJ1203A_fz_datapoints, PJ1203A_ignore_tuya_set_time],  
    toZigbee: [PJ1203A_tz_datapoints],
    onEvent: tuya.onEventSetTime,
    configure: tuya.configureMagicPacket,
    options: [
        PJ1203A_options.energy_flow_qwirk('a'),
        PJ1203A_options.energy_flow_qwirk('b'),
        PJ1203A_options.signed_power('a'),
        PJ1203A_options.signed_power('b'),
    ],
    exposes: [
        tuya.exposes.powerWithPhase('a').withCategory('diagnostic'),
        tuya.exposes.powerWithPhase('b'),
        tuya.exposes.powerWithPhase('ab').withCategory('diagnostic'),
        tuya.exposes.currentWithPhase('a'),
        tuya.exposes.currentWithPhase('b'),
        tuya.exposes.powerFactorWithPhase('a'),
        tuya.exposes.powerFactorWithPhase('b'),
        tuya.exposes.energyFlowWithPhase('a'),
        tuya.exposes.energyFlowWithPhase('b'),
        tuya.exposes.energyWithPhase('a'),
        tuya.exposes.energyWithPhase('b'),
        tuya.exposes.energyProducedWithPhase('a'),
        tuya.exposes.energyProducedWithPhase('b'),
        e.ac_frequency(),
        e.voltage(),
        e.numeric('timestamp_a', ea.STATE).withDescription('Update time of channel A'),
        e.numeric('timestamp_b', ea.STATE).withDescription('Update time of channel B'),
        e.numeric('update_frequency',ea.STATE_SET).withUnit('s').withDescription('Update frequency').withValueMin(3).withValueMax(60),
    ],
    meta: {
        tuyaDatapoints: [
            [111, 'ac_frequency', tuya.valueConverter.divideBy100],
            [112, 'voltage', tuya.valueConverter.divideBy10],
            [101, null, PJ1203A_valueConverters.power('a')],        // power_a 
            [105, null, PJ1203A_valueConverters.power('b')],        // power_b 
            [113, null, PJ1203A_valueConverters.current('a')],      // current_a 
            [114, null, PJ1203A_valueConverters.current('b')],      // current_b
            [110, null, PJ1203A_valueConverters.power_factor('a')], // power_factor_a
            [121, null, PJ1203A_valueConverters.power_factor('b')], // power_factor_b
            [102, null, PJ1203A_valueConverters.energy_flow('a')],  // energy_flow_a or the sign of power_a 
            [104, null, PJ1203A_valueConverters.energy_flow('b')],  // energy_flow_b or the sign of power_b
            [115, null, PJ1203A_valueConverters.power_ab()],
            [106, 'energy_a', tuya.valueConverter.divideBy100],
            [108, 'energy_b', tuya.valueConverter.divideBy100],
            [107, 'energy_produced_a', tuya.valueConverter.divideBy100],
            [109, 'energy_produced_b', tuya.valueConverter.divideBy100],
            [129, 'update_frequency', tuya.valueConverter.raw],
        ],
    },
};

module.exports = definition;

