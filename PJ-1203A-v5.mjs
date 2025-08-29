// V5: Added one-time zero's removal option

// @ts-nocheck
import fz from "zigbee-herdsman-converters/converters/fromZigbee";
import tz from "zigbee-herdsman-converters/converters/toZigbee";
import { presets, access, binary } from "zigbee-herdsman-converters/lib/exposes";
import { fz as _fz, tz as _tz, fingerprint as _fingerprint, onEventSetTime, configureMagicPacket, exposes as _exposes, valueConverter } from "zigbee-herdsman-converters/lib/tuya";
import utils from "zigbee-herdsman-converters/lib/utils";
import { getValue, putValue } from "zigbee-herdsman-converters/lib/store";
const e = presets;
const ea = access;

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

/**
 * @param {{ device: import("zigbee-herdsman/dist/controller/model/endpoint.js").Endpoint | import("zigbee-herdsman/dist/controller/model/group.js").Group | import("zigbee-herdsman/dist/controller/model/device.js").Device; }} meta
 */
function pj1203aGetPrivateState(meta) {
    let priv = getValue(meta.device, "private_state");
    if (priv === undefined) {
        priv = {
            sign_a: null,
            sign_b: null,
            power_a: null,
            power_b: null,
            current_a: null,
            current_b: null,
            power_factor_a: null,
            power_factor_b: null,
            timestamp_a: null,
            timestamp_b: null,
            // Used to detect missing or misordered messages.
            // The _TZE204_81yrt3lo uses an increment of 256.
            last_seq: -99999,
            seq_inc: 256,
            // Also need to save the last published SIGNED values of
            // power_a and power_b to recompute power_ab on the fly.
            pub_power_a: null,
            pub_power_b: null,
            // Used to detect single zero values
            zero_power_a: null,
            zero_power_b: null,
            zero_current_a: null,
            zero_current_b: null,
        };
        putValue(meta.device, "private_state", priv);
    }
    return priv;
}

const pj1203aOptions = {
    late_energy_flow: (/** @type {string} */ x) =>
        binary(`late_energy_flow_${x.toUpperCase()}`, ea.SET, true, false)
            .withDescription(
                ` If true then delay channel ${x.toUpperCase()} publication until the next energy flow update. The default is false.`,
            ),

    signed_power: (/** @type {string} */ x) =>
        binary(`signed_power_${x.toUpperCase()}`, ea.SET, true, false)
            .withDescription(
                ` If true then power_${x} is signed otherwise the direction is provided by energy_flow_${x}. The default is false.`,
            ),
    single_zero_remove: () =>
        binary(`single_zero_remove`, ea.SET, true, false)
            .withDescription(
                ` If true then single-zero power or current values will be disgarded. The default is false.`,
            ),
};

/**
 * @param {{ [x: string]: any; }} options
 * @param {string} x
 */
function pj1203aGetLateEnergyFlow(options, x) {
    const key = `late_energy_flow_${x.toUpperCase()}`;
    if (key in options) return options[key];
    false;
}

/**
 * @param {{ [x: string]: any; }} options
 * @param {string} x
 */
function pj1203aGetSignedPower(options, x) {
    const key = `signed_power_${x.toUpperCase()}`;
    if (key in options) return options[key];
    false;
}
/**
 * @param {{ [x: string]: any; }} options
 */
function pj1203aGetSingleZeroRemove(options) {
    const key = `single_zero_remove`;
    if (key in options) return options[key];
    false;
}

// Recompute power_ab when power_a or power_b is published.
/**
 * @param {{ [x: string]: number; power_a: number; energy_flow_a: string; power_b: number; energy_flow_b: string; }} result
 * @param {{ pub_power_a: number | null; pub_power_b: number | null; }} priv
 * @param {any} options
 */
function pj1203aRecomputePowerAb(result, priv, options) {
    let modified = false;

    // Important: 'power_x' and 'energy_flow_x' must be published together

    if ("power_a" in result) {
        priv.pub_power_a = result.power_a * (result.energy_flow_a === "producing" ? -1 : 1);
        modified = true;
    }
    if ("power_b" in result) {
        priv.pub_power_b = result.power_b * (result.energy_flow_b === "producing" ? -1 : 1);
        modified = true;
    }

    if (modified) {
        if (priv.pub_power_a !== null && priv.pub_power_b !== null) {
            // Note: We need to "cancel" and reapply the scaling by 10
            //       because of annoying floating-point rounding errors.
            //       For example:
            //          79.8 - 37.1  --> 42.699999999999996
            result.power_ab = Math.round(10 * priv.pub_power_a + 10 * priv.pub_power_b) / 10;
        }
    }
}

/**
 * @param {{ [x: string]: any; }} result
 * @param {string} x
 * @param {{ [x: string]: any; }} priv
 * @param {any} options
 */
function pj1203aFlushAll(result, x, priv, options) {
    const sign = priv[`sign_${x}`];
    const power = priv[`power_${x}`];
    const current = priv[`current_${x}`];
    const power_factor = priv[`power_factor_${x}`];

    // Make sure that we use them only once. No obsolete data!!!!
    priv[`sign_${x}`] = priv[`power_${x}`] = priv[`current_${x}`] = priv[`power_factor_${x}`] = null;

    // And only publish after receiving a complete set
    if (sign !== null && power !== null && current !== null && power_factor !== null) {
        if (pj1203aGetSignedPower(options, x)) {
            result[`power_${x}`] = sign * power;
            result[`energy_flow_${x}`] = "sign";
        } else {
            result[`power_${x}`] = power;
            result[`energy_flow_${x}`] = sign > 0 ? "consuming" : "producing";
        }
        result[`timestamp_${x}`] = priv[`timestamp_${x}`];
        result[`current_${x}`] = current;
        result[`power_factor_${x}`] = power_factor;
        pj1203aRecomputePowerAb(result, priv, options);
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
/**
 * @param {{}} result
 * @param {string} x
 * @param {{ [x: string]: number; }} priv
 * @param {any} options
 */
function pj1203aFlushZero(result, x, priv, options) {
    priv[`sign_${x}`] = +1;
    priv[`power_${x}`] = 0;
    priv[`timestamp_${x}`] = new Date().toISOString();
    priv[`current_${x}`] = 0;
    priv[`power_factor_${x}`] = 100;
    pj1203aFlushAll(result, x, priv, options);
}
// Some times the device sends a single zero value (either power or current).
// This is most likely a glitch. We flush all values but set them to null
// to indicate that they are not valid.
//
/**
 * @param {{}} result
 * @param {string} x
 * @param {{ [x: string]: number; }} priv
 * @param {any} options
 */
function pj1203aFlushNull(result, x, priv, options) {
    priv[`sign_${x}`] = priv[`power_${x}`] = priv[`current_${x}`] = priv[`power_factor_${x}`] = null;
    priv[`timestamp_${x}`] = new Date().toISOString();
    pj1203aFlushAll(result, x, priv, options);
}
const pj1203aValueConverters = {
    energy_flow: (/** @type {string} */ x) => {
        return {
            from: (/** @type {number} */ v, /** @type {any} */ meta, /** @type {any} */ options) => {
                const priv = pj1203aGetPrivateState(meta);
                const result = {};
                priv[`sign_${x}`] = v === 1 ? -1 : +1;
                const late_energy_flow = pj1203aGetLateEnergyFlow(options, x);
                if (late_energy_flow) {
                    pj1203aFlushAll(result, x, priv, options);
                }
                return result;
            },
        };
    },

    power: (/** @type {string} */ x) => {
        return {
            from: (/** @type {number} */ v, /** @type {any} */ meta, /** @type {any} */ options) => {
                const priv = pj1203aGetPrivateState(meta);
                const result = {};
                const power_x = v / 10.0;

                priv[`power_${x}`] = power_x;
                priv[`timestamp_${x}`] = new Date().toISOString();

                if (v === 0) {

                    const single_zero_remove = pj1203aGetSingleZeroRemove(options);
                    if (single_zero_remove && !priv[`zero_power_${x}`]) {
                        meta.logger.debug(`[PJ1203A] power is zero, flushing one time`);
                        pj1203aFlushNull(result, x, priv, options);
                    }
                    else{
                        pj1203aFlushZero(result, x, priv, options);
                    }
                    priv[`zero_power_${x}`] = true;
                }else{
                    priv[`zero_power_${x}`] = false;
                }

                return result;
            },
        };
    },

    current: (/** @type {string} */ x) => {
        return {
            from: (/** @type {number} */ v, /** @type {any} */ meta, /** @type {any} */ options) => {
                const priv = pj1203aGetPrivateState(meta);
                const result = {};
                const current_x = v / 1000.0;

                priv[`current_${x}`] = current_x;

                if (v === 0) {
                    const single_zero_remove = pj1203aGetSingleZeroRemove(options);
                    if (single_zero_remove && !priv[`zero_current_${x}`]) {
                        meta.logger.debug(`[PJ1203A] current is zero, flushing one time`);
                        pj1203aFlushNull(result, x, priv, options);
                    }
                    else{
                        pj1203aFlushZero(result, x, priv, options);
                    }
                    priv[`zero_current_${x}`]= true;
                }else{
                    priv[`zero_current_${x}`] = false;
                }

                return result;
            },
        };
    },

    power_factor: (/** @type {string} */ x) => {
        return {
            from: (/** @type {any} */ v, /** @type {any} */ meta, /** @type {any} */ options) => {
                const priv = pj1203aGetPrivateState(meta);
                const result = {};
                priv[`power_factor_${x}`] = v;

                const late_energy_flow = pj1203aGetLateEnergyFlow(options, x);
                if (!late_energy_flow) {
                    pj1203aFlushAll(result, x, priv, options);
                }
                return result;
            },
        };
    },

    // We currently discard the power_ab datapoint
    // but it is recomputed on the fly to match
    // the published values of power_a and power_b.
    power_ab: () => {
        return {
            from: (/** @type {any} */ v, /** @type {any} */ meta, /** @type {any} */ options) => {
                return {};
            },
        };
    },
};

//
// A customized version of fz.ignore_tuya_set_time
// that also increases our private 'next_seq' field.
//
// This is needed to prevent 'commandMcuSyncTime' from
// messing up with the detection of missing datapoints (see
// below in PJ1203A_fz_datapoints).
//
const pj1203aIgnoreTuyaSetTime = {
    cluster: "manuSpecificTuya",
    type: ["commandMcuSyncTime"],
    convert: (/** @type {any} */ model, /** @type {any} */ msg, /** @type {any} */ publish, /** @type {any} */ options, /** @type {any} */ meta) => {
        // There is no 'seq' field in the msg payload of 'commandMcuSyncTime'
        // but the device appears to be increasing its internal counter.
        const priv = pj1203aGetPrivateState(meta);
        priv.last_seq += priv.seq_inc;
    },
};

//
// This is basically tuya.fz.datapoints extended to detect missing
// or reordered messages.
//
const pj1203aFzDatapoints = {
     ..._fz.datapoints,

    convert: (/** @type {import("zigbee-herdsman-converters").Definition} */ model, /** @type {import("zigbee-herdsman-converters/lib/types").Fz.Message} */ msg, /** @type {import("zigbee-herdsman-converters/lib/types").Publish} */ publish, /** @type {import("zigbee-herdsman-converters/lib/types").KeyValue} */ options, /** @type {import("zigbee-herdsman-converters/lib/types").Fz.Meta} */ meta) => {
        const result = {};

        // Uncomment the next line to test the behavior
        // when random messages are lost
        // if ( Math.random() < 0.05 ) return ;

        const priv = pj1203aGetPrivateState(meta);

        // Detect missing or re-ordered messages but allow duplicate messages (should we?).
        const expected_seq = (priv.last_seq + priv.seq_inc) & 0xffff;
        if (msg.data.seq !== expected_seq && msg.data.seq !== priv.last_seq) {
            meta.logger.debug(`[PJ1203A] Missing or re-ordered message detected: Got seq=${msg.data.seq}, expected ${priv.next_seq}`);
            // Clear all pending attributes since we cannot insure that they match
            priv.sign_a = null;
            priv.sign_b = null;
            priv.power_a = null;
            priv.power_b = null;
            priv.current_a = null;
            priv.current_b = null;
            priv.power_factor_a = null;
            priv.power_factor_b = null;

            priv.zero_power_a = null;
            priv.zero_power_b = null;
            priv.zero_current_a = null;
            priv.zero_current_b = null;
        }

        priv.last_seq = msg.data.seq;

        // And finally, process the dp with tuya.fz.datapoints
        Object.assign(result, _fz.datapoints.convert(model, msg, publish, options, meta));

        // REMINDER: MUST BE REMOVED IN FINAL RELEASE
        // meta.logger.debug(`[PJ1203A] priv   = ${JSON.stringify(priv)}`);
        // meta.logger.debug(`[PJ1203A] result = ${JSON.stringify(result)}`);

        return result;
    },
};

const pj1203aTzDatapoints = {
    ..._tz.datapoints,
    key: [
        "update_frequency",
        "calibration_energy_a",
        "calibration_energy_b",
        "calibration_energy_produced_a",
        "calibration_energy_produced_b",
        "calibration_power_a",
        "calibration_power_b",
        "calibration_current_a",
        "calibration_current_b",
        "calibration_ac_frequency",
        "calibration_voltage",
    ],
};

const definition = {
    fingerprint: _fingerprint("TS0601", ["_TZE284_81yrt3lo"]),
    model: "PJ-1203A",
    vendor: "TuYa",
    description: "Bidirectional energy meter with 80A current clamp (CUSTOMIZED by MHA)",
    fromZigbee: [pj1203aFzDatapoints, pj1203aIgnoreTuyaSetTime],
    toZigbee: [pj1203aTzDatapoints],
    onEvent: onEventSetTime,
    configure: configureMagicPacket,
    options: [
        pj1203aOptions.late_energy_flow("a"),
        pj1203aOptions.late_energy_flow("b"),
        pj1203aOptions.signed_power("a"),
        pj1203aOptions.signed_power("b"),
        pj1203aOptions.single_zero_remove(),
    ],
    exposes: [
        // Note: A and B are are not really phases (as in 3-phases). They are independant channels.
        _exposes.powerWithPhase("a"),
        _exposes.powerWithPhase("b"),
        _exposes.powerWithPhase("ab"),
        _exposes.currentWithPhase("a"),
        _exposes.currentWithPhase("b"),
        _exposes.powerFactorWithPhase("a"),
        _exposes.powerFactorWithPhase("b"),
        _exposes.energyFlowWithPhase("a", ["sign"]),
        _exposes.energyFlowWithPhase("b", ["sign"]),
        _exposes.energyWithPhase("a"),
        _exposes.energyWithPhase("b"),
        _exposes.energyProducedWithPhase("a"),
        _exposes.energyProducedWithPhase("b"),
        e.ac_frequency(),
        e.voltage(),
        // Timestamp a and b are basically equivalent to last_seen
        // but they indicate when the unsigned value of power_a and power_b
        // were received. They can be several seconds in the past when
        // the publication is delayed because of the late_energy_flow options.
        e
            .numeric("timestamp_a", ea.STATE)
            .withDescription("Timestamp of power A measure"),
        e
            .numeric("timestamp_b", ea.STATE)
            .withDescription("Timestamp of power B measure"),
        e
            .numeric("update_frequency", ea.STATE_SET)
            .withUnit("s")
            .withDescription("Update frequency")
            .withValueMin(3)
            .withValueMax(60)
            .withPreset("default",10, "Default value"),
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
            [111, "ac_frequency", valueConverter.divideBy100],
            [112, "voltage", valueConverter.divideBy10],
            [101, null, pj1203aValueConverters.power("a")], // power_a
            [105, null, pj1203aValueConverters.power("b")], // power_b
            [113, null, pj1203aValueConverters.current("a")], // current_a
            [114, null, pj1203aValueConverters.current("b")], // current_b
            [110, null, pj1203aValueConverters.power_factor("a")], // power_factor_a
            [121, null, pj1203aValueConverters.power_factor("b")], // power_factor_b
            [102, null, pj1203aValueConverters.energy_flow("a")], // energy_flow_a or the sign of power_a
            [104, null, pj1203aValueConverters.energy_flow("b")], // energy_flow_b or the sign of power_b
            [115, null, pj1203aValueConverters.power_ab()],
            [106, "energy_a", valueConverter.divideBy100],
            [108, "energy_b", valueConverter.divideBy100],
            [107, "energy_produced_a", valueConverter.divideBy100],
            [109, "energy_produced_b", valueConverter.divideBy100],
            [129, "update_frequency", valueConverter.raw],
            //[116, 'calibration_voltage', tuya.valueConverter.divideBy1000],
            //[117, 'calibration_current_a', tuya.valueConverter.divideBy1000],
            [118, 'calibration_power_a', valueConverter.divideBy1000], // MHA: line activated
            //[119, 'calibration_energy_a', tuya.valueConverter.divideBy1000],
            //[127, 'calibration_energy_produced_a', tuya.valueConverter.divideBy1000],
            //[122, 'calibration_ac_frequency', tuya.valueConverter.divideBy1000],
            //[123, 'calibration_current_b', tuya.valueConverter.divideBy1000],
            [124, 'calibration_power_b', valueConverter.divideBy1000], // MHA: line activated
            //[125, 'calibration_energy_b', tuya.valueConverter.divideBy1000],
            //[128, 'calibration_energy_produced_b', tuya.valueConverter.divideBy1000],
        ],
    },
};

export default definition;
