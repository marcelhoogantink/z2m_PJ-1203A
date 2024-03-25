const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const extend = require('zigbee-herdsman-converters/lib/extend');
const tuya = require('zigbee-herdsman-converters/lib/tuya');
const utils = require('zigbee-herdsman-converters/lib/utils');
const e = exposes.presets;
const ea = exposes.access;
const {Buffer} = require('buffer');

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
// Ideally, each 'energy_flow_x' should be intepreted as the direction 
// of the 'current_x' and 'power_x' in the same group of message.
// This is unfortunately not the case. For at least some versions (e.g. _TZE204_81yrt3lo),
// the proper 'energy_flow_x' is only provided in the NEXT sequence of messages so
// after a delay of 'update_frequency'.   
//
// For example, that means that when switching from "producing 100W" to
// "consuming 500W", there will be an intermediate state showing "producing 500W".
//
// It is unclear if that problem exists in all versions. An OTA update may even
// be available. More information needed!!!! 
// 
// The following implementation tries to solve that issue by caching energy_flow_x,
// current_x, power_x and power_factor_b in an internal private state. 
// 
// The option 
//
//   'no'      This is the original behavior. The power is provided unsigned.
//             This is the default mode. 
//
//   'yes'     The sign of power_x is obtained from energy_flow_x in the same burst. 
//
//   'delayed' The sign of power_x is obtained from energy_flow_x in the NEXT burst.
//             In practice, that means that power_x is delayed by `update_frequency`
//             seconds. Also, be aware that power_x will not anymore be synchronized with
//             current_x, energy_flow_x, power_factor_x and power_ab.
//
// Zigbee messages can be missing, reordered or duplicated so matching each power
// with the proper energy_flow is not always possible. Fortunately, the tuya
// datapoint messages are numbered so most networking issues can be detected.
//
// The behavior when missing or reordered messages are detected between the
// power_x and the matching energy_flow_x is controlled by the option
// signed_power_recovery:
//
//   'optimistic'   Do as if all messages were received in the proper order. There
//                  is no guarantee that power_x will be given an accurate sign.
//
//   'ignore'       power_x is not published but the old value remains available  
//                  until better data is obtained.
//
//   'clear'        power_x is temporarily set to 'null' until better data is obtained.
//
//  
// IMPORTANT: No attempt is made to fix 'power_ab'. It should probably be
//            treated as broken on all devices with late 'energy_flow_x'
//            datapoints. In theory, 'power_ab' could easily be recomputed as 
//            to 'power_a+power_b' using signed power_a and signed_b.   
//
// Also, some private data are stored in 'meta.device._priv' with the
// following entries:
//
//  - 'pending_power_a' and 'pending_power_a'
//
//       Contain the last known unsigned power values provided by the datapoints 101 and 105.
//       
//       The value can also be null
//           - at startup (so before receiving the first datapoints 101 and 105)
//           - or after detecting missing or misordered datapoints (in non-optimistic recovery mode)
//
//  - 'pending_power_sign_a' and 'pending_power_sign_a'
//
//       Contain the power sign +1 or -1 as defined by the datapoints 102 and 104.
//
//       The value can also be null
//           - at startup (so before receiving the first datapoints 101 and 105)
//           - or after detecting some missing or misordered datapoints (in non-optimistic recovery mode)
//
//  - 'last_seq'
//
//       The 'seq' value found in the last tuya payload. This is used to detect
//       missing or reordered messages. 
//

function PJ1203A_getPrivateState(meta) {
    return meta.device._priv ;
}

function PJ1203A_providePrivateState(meta) {
    if ( ! ('_priv' in meta.device) ) {
        meta.device._priv = {
            'energy_flow_a': null, 
            'energy_flow_b': null, 
            'power_a': null, 
            'power_b': null,
            'current_a': null,
            'current_b': null,
            'power_factor_a': null,
            'power_factor_b': null,
            'last_seq': -99999,
            'counter_a':0,  
            'counter_b':0,  
         } ;
    }      
    return meta.device._priv ;
}

// The _TZE204_81yrt3lo increments its payload 'seq' value by steps of 256
// This is hopefully the same for all variants. 
const PJ1203A_SEQ_INCREMENT = 256 ; 


const PJ1203A_options = {
    missing_message_detection: () => exposes.binary('missing_message_detection', ea.SET, true, false )
        .withDescription(
            'Discard all pending data when missing or reordered messages are detected. Default is false'),
    publishing_mode: () => exposes.enum('publishing_mode', ea.SET, ['immediate','at_power_factor','at_energy_flow'] )
        .withDescription(
            'Define when energy_flow_x, power_x, current_x and power_factor_x are published.'+
                ' With \'immediate\' they are published individually as soon as they are received.'+
                ' With \'at_power_factor\' they are published together after receiving power_factor_x.'+
                ' With \'at_energy_flow\' they are published together after receiving energy_flow_x'+
                ' which typically happens during the next update ; this is slower but can provide'+
                ' more accurate energy flow direction on some devices'                
        ),
    missing_data_behavior: () => exposes.enum('missing_data_behavior', ea.SET, ['keep_missing','keep_all','nullify_missing', 'nullify_all' ] )
        .withDescription(
            'Define the behavior when some of energy_flow_x, power_x, current_x and power_factor_x are missing.'+
                ' That has no effect in \'immediate\' publishing mode. '+
                ' With \'keep_missing\' the missing attributes keep they old value. '+
                ' With \'keep_all\' (the default) no attribute is published so they all keep they old value. '+
                ' With \'nullify_missing\' the missing attributes are set to null. '+
                ' With \'nullify_all\' all attributes are set to null'),
};

function PJ1203A_get_missing_message_detection(options) {
    return options?.missing_message_detection || false ;
}

function PJ1203A_get_publishing_mode(options) {
    return options?.publishing_mode || 'immediate' ;
}

function PJ1203A_get_missing_data_behavior(options) {
    return options?.missing_data_behavior || 'keep_all' ;
}

// Change the counter_a or counter_b attribute 
function PJ1203A_next_seq(result,priv,x) {
    let counter_x = 'counter_'+x ;
    result[counter_x] = priv[counter_x] = ( priv[counter_x] + 1 ) & 0xFFFF ;
}

function PJ1203A_flush_all(result,x,priv,options,clear) {

    let energy_flow  = priv['energy_flow_'+x] ; 
    let power        = priv['power_'+x] ; 
    let current      = priv['current_'+x] ; 
    let power_factor = priv['power_factor_'+x] ;

    // Make sure that we use them only once.
    if (clear) {
        priv['energy_flow_'+x] = priv['power_'+x] = priv['current_'+x] = priv['power_factor_'+x] = null ;
    }

    if ( energy_flow!==null && power!==null && current!==null && power_factor!==null ) {
        result['energy_flow_'+x]  = energy_flow;
        result['power_'+x]        = power;
        result['current_'+x]      = current;
        result['power_factor_'+x] = power_factor;
        PJ1203A_next_seq(result, priv, x);
        return ;
    }
    
    // Some attributes are missing. 

    const missing_data_behavior = PJ1203A_get_missing_data_behavior(options);

    if ( missing_data_behavior=='keep_missing' ) {
        if (energy_flow!==null)  result['energy_flow_'+x] = energy_flow;
        if (power!==null)        result['power_'+x] = power;
        if (current!==null)      result['current_'+x] = current;
        if (power_factor!==null) result['power_factor_'+x] = power_factor;
    } else if ( missing_data_behavior=='nullify_missing' ) {
        // remark: the missing data are already null so publish everything as is
        result['energy_flow_'+x]  = energy_flow;
        result['power_'+x]        = power;
        result['current_'+x]      = current;
        result['power_factor_'+x] = power_factor;
    } else if ( missing_data_behavior=='nullify_all' ) {
        result['energy_flow_'+x]  = null;
        result['power_'+x]        = null;
        result['current_'+x]      = null;
        result['power_factor_'+x] = null;
    }

    PJ1203A_next_seq(result, priv, x);   
    return ;
}

// When the device does not detect any flow, it stops sending 
// energy_flow_x and always set current_x=0, power_x=0 and
// power_factor_x=100.
//
// So if we see a datapoint for current_x==0 or power_x==0
// then we can safely assume that we are in that zero energy state.
//
function PJ1203A_flush_zero(result,x,priv,options) {
    priv['energy_flow_'+x] = "consuming" ; 
    priv['power_'+x] = 0 ;
    priv['current_'+x] = 0 ;
    priv['power_factor_'+x] = 100 ;
    PJ1203A_flush_all(result, x, priv,options, false); 
}

const PJ1203A_valueConverters = {
    
    energy_flow: (x) =>  {
        return {
            from: (v, meta, options) => {
                let priv = PJ1203A_providePrivateState(meta) ;
                let result = {} ;           

                let flow ;                
                if (v==0) {
                    flow = "consuming" ;
                } else if (v==1) {
                    flow = "producing" ;
                } else {
                    meta.logger.debug(`[PJ1203A] unexpected value {v} for {'energy_flow_'+x}`);
                    flow = "unknown" ;
                }
                priv['energy_flow_'+x] = flow ;

                let publishing_mode = PJ1203A_get_publishing_mode(options) ;

                if ( publishing_mode == 'immediate' ) {
                    result['energy_flow_'+x] = flow;
                    PJ1203A_next_seq(result, priv, x);   
                } else if ( publishing_mode == 'at_energy_flow' ) {
                    PJ1203A_flush_all(result, x, priv, options, true); 
                }

               return result ;
            } 
        };
    }, // end of energy_flow:

    power: (x) => {
        return {
            from: (v, meta, options) => {

                let priv = PJ1203A_providePrivateState(meta) ;
                let result = {} ;

                let power_x =  v / 10.0 ;
                
                priv['power_'+x] = power_x;  

                if (v==0) {
                    PJ1203A_flush_zero(result, x, priv, options);
                    return result;
                }

                let publishing_mode = PJ1203A_get_publishing_mode(options) ;
                if ( publishing_mode == 'immediate' ) {
                    result['power_'+x] = power_x;
                    PJ1203A_next_seq(result, priv, x);   
               }
                
                return result;
            }
        };
    },  // end of power:

    current: (x) => {
        return {
            from: (v, meta, options) => {

                let priv = PJ1203A_providePrivateState(meta) ;
                let result = {} ;
                let current_x = v / 1000.0 ;
                
                priv['current_'+x] = current_x ;  

                if (v==0) {
                    PJ1203A_flush_zero(result, x, priv, options);
                    return result;                    
                }

                let publishing_mode = PJ1203A_get_publishing_mode(options) ;
                if ( publishing_mode == 'immediate' ) {
                    result['current_'+x] = current_x;
                    PJ1203A_next_seq(result, priv, x);   
                }
                
                return result;
            }
        };
    },  // end of current: 
    
    power_factor: (x) => {
        return {
            from: (v, meta, options) => {

                let priv = PJ1203A_providePrivateState(meta) ;
                let result = {} ;
                let power_factor_x = v ;
                
                priv['power_factor_'+x] = power_factor_x ;  
                let publishing_mode = PJ1203A_get_publishing_mode(options) ;
                if ( publishing_mode == 'immediate' ) {
                    result['power_factor_'+x] = power_factor_x ;
                    PJ1203A_next_seq(result, priv, x);   
                } else if (publishing_mode == 'at_power_factor' ) {
                    PJ1203A_flush_all(result, x, priv, options, true); 
                }            
                return result;
            }
        };
    },  // end of current: 
    
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
       let priv = PJ1203A_providePrivateState(meta) ;
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
        
        let priv = PJ1203A_providePrivateState(meta) ;

        if ( PJ1203A_get_missing_message_detection(options) ) {
            // Detect missing or re-ordered messages but allow duplicate messages.
            let expected_seq = (priv.last_seq+PJ1203A_SEQ_INCREMENT) & 0xFFFF ;
            if (   ( msg.data.seq != expected_seq ) && ( msg.data.seq != priv.last_seq ) )  {             
                meta.logger.debug(`[PJ1203A] Missing or re-ordered message detected: Got seq=${msg.data.seq}, expected ${priv.next_seq}`);
                // Clear all pending attributes 
                priv.energy_flow_a = null;
                priv.energy_flow_b = null;
                priv.power_a = null;
                priv.power_b = null;
                priv.current_a = null;
                priv.current_b = null;
                priv.power_factor_a = null;
                priv.power_factor_b = null;
            }
        }
        
        priv.last_seq =  msg.data.seq;


        
        // Uncomment to display private data in the state (for debug)   
        // result['priv'] = priv ;

        // Uncomment to display device data in the state (for debug)   
        // result['device'] = meta.device ;
        
        // Uncomment to display the whole message in the state (for debug)   
        result['msg'] = msg ;
        
        // And finally, perform the dp convertion with tuya.fz.datapoints  
        Object.assign( result, tuya.fz.datapoints.convert(model, msg, publish, options, meta) ) ;

        return result;
    }
};

const PJ1203A_tz_datapoints = {
    ...tuya.tz.datapoints,
    key: [ 'update_frequency' ]
};

// WARNING !!!! only tested on _TZE204_81yrt3lo
const definition = {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE204_81yrt3lo', '_TZE200_rks0sgb7']),
        model: 'PJ-1203A',
        vendor: 'TuYa',
        description: 'Bidirectional energy meter with 80A current clamp',
        fromZigbee: [PJ1203A_fz_datapoints, PJ1203A_ignore_tuya_set_time],  
        toZigbee: [PJ1203A_tz_datapoints],
        onEvent: tuya.onEventSetTime,
        configure: tuya.configureMagicPacket,
        options: [
            PJ1203A_options.publishing_mode(),
            PJ1203A_options.missing_message_detection(),
            PJ1203A_options.missing_data_behavior(),
        ],
        exposes: [
            tuya.exposes.powerWithPhase('a'), tuya.exposes.powerWithPhase('b'), tuya.exposes.powerWithPhase('ab'),
            tuya.exposes.currentWithPhase('a'), tuya.exposes.currentWithPhase('b'),
            tuya.exposes.powerFactorWithPhase('a'), tuya.exposes.powerFactorWithPhase('b'),
            tuya.exposes.energyFlowWithPhase('a'), tuya.exposes.energyFlowWithPhase('b'),
            tuya.exposes.energyWithPhase('a'), tuya.exposes.energyWithPhase('b'),
            tuya.exposes.energyProducedWithPhase('a'), tuya.exposes.energyProducedWithPhase('b'),
            e.ac_frequency(),
            e.voltage(),
            e.numeric('counter_a', ea.STATE).withDescription('Counter for phase a updates (16bits)'),
            e.numeric('counter_b', ea.STATE).withDescription('Counter for phase b updates (16bits)'),
            e.numeric('update_frequency',ea.STATE_SET).withUnit('s').withDescription('Update frequency').withValueMin(3).withValueMax(60),
        ],
        meta: {
            tuyaDatapoints: [
                [111, 'ac_frequency', tuya.valueConverter.divideBy100],
                [112, 'voltage', tuya.valueConverter.divideBy10],
                [101, null, PJ1203A_valueConverters.power('a')],
                [105, null, PJ1203A_valueConverters.power('b')],
                [113, null, PJ1203A_valueConverters.current('a')],
                [114, null, PJ1203A_valueConverters.current('b')],
                [110, null, PJ1203A_valueConverters.power_factor('a')],
                [121, null, PJ1203A_valueConverters.power_factor('b')],
                [102, null, PJ1203A_valueConverters.energy_flow('a')],
                [104, null, PJ1203A_valueConverters.energy_flow('b')],
                [115, 'power_ab', tuya.valueConverter.divideBy10],

                [106, 'energy_a', tuya.valueConverter.divideBy100],
                [108, 'energy_b', tuya.valueConverter.divideBy100],
                [107, 'energy_produced_a', tuya.valueConverter.divideBy100],
                [109, 'energy_produced_b', tuya.valueConverter.divideBy100],
                [129, 'update_frequency', tuya.valueConverter.raw],
            ],
        },
    };

module.exports = definition;

