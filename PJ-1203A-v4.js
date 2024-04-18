const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const tuya = require('zigbee-herdsman-converters/lib/tuya');
const utils = require('zigbee-herdsman-converters/lib/utils');
const globalStore = require('zigbee-herdsman-converters/lib/store');
const e = exposes.presets;
const ea = exposes.access;


// The PJ1203A is sending quick sequence of messages containing a single datapoint.
// A sequence occurs every `update_frequency` seconds (10s by default) 
//
// A typical sequence is composed of two identical groups for channel a and b. 
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
// energy_flow_x is not emited and current_x==0, power_x==0 and power_factor_x==100.
//
// The other datapoints are emitted every few minutes.  
//
// There is a known issue on the _TZE204_81yrt3lo with appVersion 74, stackVersion 0 and hwVersion 1. 
// The energy_flow datapoints are (incorrectly) emited during the next update. Simply speaking, they 
// energy flow direction arrives `update_frequency` too late. This is highly problematic because that
// means that incoherent data can be published.
// 
//   For example, suppose that solar panels are producing an excess of 100W on channel X and that
//   a device that consumes 500W is turned on. The following states will be published in MQTT
//
//   ...
//   { "energy_flow_x":"producing" , "power_x":100 , ... }
//   ...  
//   { "energy_flow_x":"producing" , "power_x":400 , ... }
//   ... 
//   { "energy_flow_x":"consuming" , "power_x":400 , ... } 
//   ...
//
//   Channel X is seen as producing 400W during update_frequency seconds which makes no sense.
//
//   This is addressed by the late_energy_flow_x option that delays the publication of all
//   channel X attributes until the next energy_flow_x datapoint. The default is to publish  
//   when the last datapoint is received on channel X (that would typically be power_factor_x)
//  
//   Remark: When energy_flow_x is not emited (i.e. no current. see above), the publication
//   will occur immediately regardless of the late_energy_flow_x option. 
//
// For each channel X, the option signed_power_x allows to publish signed power values to indicate
// the energy flow direction (positive when "consuming" and negative when "producing"). The attribute
// energy_flow_x is then set to "sign".
//

 
function PJ1203A_getPrivateState(meta) {
    let priv = globalStore.getValue(meta.device, 'private_state') ;
    if (priv===undefined) {
        priv = {           
            'sign_a': null, 
            'sign_b': null, 
            'power_a': null, 
            'power_b': null,
            'current_a': null,
            'current_b': null,
            'power_factor_a': null,
            'power_factor_b': null,
             'timestamp_a': null,
            'timestamp_b': null,
            // Used to detect missing or misordered messages.
            // The _TZE204_81yrt3lo uses an increment of 256.
            'last_seq': -99999,
            'seq_inc' : 256,
            // Also need to save the last published SIGNED values of
            // power_a and power_b to recompute power_ab on the fly.
            'pub_power_a': null,
            'pub_power_b': null,    
        } 
        globalStore.putValue(meta.device, 'private_state', priv )  ;
    }
    return priv;
}


const PJ1203A_options = {
    
    late_energy_flow: (x) => exposes.binary('late_energy_flow_'+x.toUpperCase(), ea.SET, true, false )
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

function PJ1203A_get_late_energy_flow(options,x) {
    let key ='late_energy_flow_'+x.toUpperCase()  
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
                let late_energy_flow = PJ1203A_get_late_energy_flow(options,x)
                if (late_energy_flow) {
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

                let late_energy_flow = PJ1203A_get_late_energy_flow(options,x)
                if (!late_energy_flow) {
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
        priv.last_seq += priv.seq_inc ;
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

        // Detect missing or re-ordered messages but allow duplicate messages (should we?).
        let expected_seq = (priv.last_seq+seq_inc) & 0xFFFF ;
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

        // And finally, process the dp with tuya.fz.datapoints 
        Object.assign( result, tuya.fz.datapoints.convert(model, msg, publish, options, meta) ) ;

        // REMINDER: MUST BE REMOVED IN FINAL RELEASE
        // meta.logger.debug(`[PJ1203A] priv   = ${JSON.stringify(priv)}`);
        // meta.logger.debug(`[PJ1203A] result = ${JSON.stringify(result)}`);

        return result;
    }
};

const PJ1203A_tz_datapoints = {
    ...tuya.tz.datapoints,
    key: [ 'update_frequency',
           'calibration_energy_a',
           'calibration_energy_b',
           'calibration_energy_produced_a',
           'calibration_energy_produced_b',
           'calibration_power_a',
           'calibration_power_b',
           'calibration_current_a',
           'calibration_current_b',
           'calibration_ac_frequency',
           'calibration_voltage',
           ]
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
        PJ1203A_options.late_energy_flow('a'),
        PJ1203A_options.late_energy_flow('b'),
        PJ1203A_options.signed_power('a'),
        PJ1203A_options.signed_power('b'),
    ],
    exposes: [
        // Note: A and B are are not really phases (as in 3-phases). They are independant channels. 
        tuya.exposes.powerWithPhase('a'),
        tuya.exposes.powerWithPhase('b'),
        tuya.exposes.powerWithPhase('ab'),
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
        // Timestamp a and b are basically equivalent to last_seen
        // but they indicate when the unsigned value of power_a and power_b
        // were received. They can be several seconds in the past when
        // the publication is delayed because of the late_energy_flow options.
        e.numeric('timestamp_a', ea.STATE).withDescription('Timestamp of power A measure'),
        e.numeric('timestamp_b', ea.STATE).withDescription('Timestamp of power B measure'),
        e.numeric('update_frequency',ea.STATE_SET).withUnit('s').withDescription('Update frequency').withValueMin(3).withValueMax(60).withPreset('default',10,'Default value'),
        //
        // The calibrations are applying a scaling factor between 0.5 and 2.0 to the published value.
        // They do not affect each others. For example, voltage, power and current should be related
        // by the formula power=voltage*current but applying a calibration on one does not affect the
        // other two.
        //
        // Also, the calibration applied to power_a or power_b does not affect the accumulation
        // rate in energy_a and energy_b. This is highly misleading.  
        //
        // Simply speaking, the calibration are purely cosmetic and this is why they are commented
        // by default. Scaling is easier to achieve on the client side (e.g. in Home Assistant)       
        // 
        // WARNING: The energy calibration are applied to the TOTAL value accumulated so far.
        //   For example, if energy_a is currently reporting 20000 kWh of accumulated
        //   and calibration_energy_a is set to 1.3 then the next report is going to
        //   be 26000 kWh. Home Assistant will interpret that as a +6000kWh of instantaneous
        //   energy consumption.
        //   Simply speaking, CHANGING AN ENERGY CALIBRATION IS PROBABLY A BAD IDEA BECAUSE
        //   THIS IS GOING TO CREATE A HUGE SPIKE OR DROP IN YOUR APPARENT ENERGY CONSUMPTION
        //       
        //e.numeric('calibration_ac_frequency', ea.STATE_SET).withDescription('Calibration AC frequency').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
        //e.numeric('calibration_voltage', ea.STATE_SET).withDescription('Calibration voltage').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
        //e.numeric('calibration_energy_a', ea.STATE_SET).withDescription('Calibration energy A').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
        //e.numeric('calibration_energy_b', ea.STATE_SET).withDescription('Calibration energy B').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
        //e.numeric('calibration_energy_produced_a', ea.STATE_SET).withDescription('Calibration produced energy A').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
        //e.numeric('calibration_energy_produced_b', ea.STATE_SET).withDescription('Calibration produced energy B').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
        //e.numeric('calibration_power_a', ea.STATE_SET).withDescription('Calibration power A').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
        //e.numeric('calibration_power_b', ea.STATE_SET).withDescription('Calibration power B').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
        //e.numeric('calibration_current_a', ea.STATE_SET).withDescription('Calibration current A').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
        //e.numeric('calibration_current_b', ea.STATE_SET).withDescription('Calibration current B').withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value'),
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
            //[116, 'calibration_voltage', tuya.valueConverter.divideBy1000],
            //[117, 'calibration_current_a', tuya.valueConverter.divideBy1000],
            //[118, 'calibration_power_a', tuya.valueConverter.divideBy1000],
            //[119, 'calibration_energy_a', tuya.valueConverter.divideBy1000],
            //[127, 'calibration_energy_produced_a', tuya.valueConverter.divideBy1000],
            //[122, 'calibration_ac_frequency', tuya.valueConverter.divideBy1000],
            //[123, 'calibration_current_b', tuya.valueConverter.divideBy1000],
            //[124, 'calibration_power_b', tuya.valueConverter.divideBy1000],
            //[125, 'calibration_energy_b', tuya.valueConverter.divideBy1000],
            //[128, 'calibration_energy_produced_b', tuya.valueConverter.divideBy1000],
        ],
    },
};

module.exports = definition;

