# z2m_PJ-1203A
A small repository for my custom zigbee2mqtt converter for the PJ-1203A

I started a discussion in https://github.com/Koenkk/zigbee2mqtt/discussions/21956

and an issue in Z2M https://github.com/Koenkk/zigbee2mqtt/issues/22248


## Installation

Assuming that zigbee2mqtt is installed in `/opt/zigbee2mqtt`, copy one of the proposed variant 
to `/opt/zigbee2mqtt/data/PJ-1203A.js`. 
 
The external converter also need to be declared in `/opt/zigbee2mqtt/configuration.yaml` or in 
the web interface.
 
Be aware that `zigbee2mqtt` will fallback to the builtin `PJ-1203A` converter if the external 
file cannot be loaded or contains errors.

Syntax errors in the converters can be detected before starting zigbee2mqtt with 

    node /opt/zigbee2mqtt/data/PJ-1203A.js
    
but be aware that this trick only works for files inside the `/opt/zigbee2mqtt` directory.

Your systemd service file for zigbee2mqtt is probably redicting stderr. If you want to see all error messages, you can start zigbee2mqtt manually from the directory `/opt/zigbee2mqtt` with `npm start` or `node index.js`

## Introduction

My converter is based on the version currently found in zigbee2mqtt (as of March 25th 2024) and it should hopefully remain backward compatible with the default values of the new settings.

My main concern with the current `PJ-1203A` converter was what should probably called a bug in the device. For channel x, the 4 attributes `energy_flow_x`, `current_x`, `power_x` and `power_factor_x` are regularly provided in that order. This is a bi-directional sensor so `energy_flow_x` describes the direction of the current and can be either `consuming` or `producing`. Unfortunately, that attribute is not properly synchronized with the other three. In practice, that means that zigbee2mqtt reports a incorrect energy flow during a few seconds when switching  between `consuming` and `producing`.

For example, suppose that some solar panels are producing an excess of 100W and that a device that consumes 500W is turned on. The following MQTT message would be produced:

    ...
    { "energy_flow_a":"producing" , "power_a":100 , ... } 
    { "energy_flow_a":"producing" , "power_a":400 , ... } 
    { "energy_flow_a":"consuming" , "power_a":400 , ... } 
    ...
    
The second message is obviously incorrect. 

Another issue is that zigbee messages can be lost or reordered. A MQTT client has no way to figure out if the attributes `energy_flow_x`, `power_x`, `current_x` and `power_factor_x` represent a coherent view of a single point in time. Some may be older that others. 

My converter is attempting to solve those issues by delaying the publication of `energy_flow_x`, `power_x`, `current_x` and `power_factor_x` until a complete and hopefully coherent set to attributes is available. It also tries to detect missing or reordered zigbee messages. 


## Variants

Each of the files `PJ_1203A-v*.js` is a variant 

## PJ_1203A-v1.js

This is the first version proposed in this repository. It should be backwark compatible with the 
current converter in zigbee2mqtt but multiple options are provided to fine tune the behavior.

It works but, IMHO it is far too complex. 

## PJ_1203A-v2.js

This is a simplified variant with the following features:
  - a single option to delay the publication until the next update (see the bug described above).
  - for each channel, the power, current, power factor and energy flow datapoints 
    are collected and are published together. Nothing is published when some of 
    them are missing or if some zigbee messages were lost or reordered (the 
    collected data may not be coherent).
  - `energy_flow_a` and `energy_flow_b` are not published anymore. Instead `power_a`
    and `power_b` are signed values: positive while consuming and negative 
    while producing.
  - A new attribute `update_x` is publied every time `power_x`, `current_x`, 
    `power_factor_x` are successfully updated on channel `x`. Only the changes 
    to `update_x` are relevant while the actual values are not (e.g. a reset or
    an increase by more than 1 is possible and does NOT indicate that an update 
    was missed). 

## PJ_1203A-v3.js

Similar to PJ_1203A-v2 with the following changes:
  - An option to control how the energy flow direction should be reported:
     `consuming` or `producing` in `energy_flow_x` or as the sign of `power_x` (in 
     which case `energy_flow_x` is set to `sign`)
  - Separate options for channels A and B (where applicable).
  - `update_a` and `update_b` are replaced by `timestamp_a` and `timestamp_b`
    whose values indicate when the corresponding power datapoint was received 
    in ISO_8601 format. That makes them valid timestamps in Home Assistant (see below).
  - The calibration datapoints (from x0.5 to x2.0) are now working but are 
    commented in the code because they are purely cosmetic (see below). 
      
## PJ_1203A-v4.js

Similar to PJ_1203A-v3 with the following changes:
  - Renamed options `energy_flow_qwirk_x` to `late_energy_flow_x`.
  - Use globalStore for the private state
  - Misc cleanups before asking Z2M to integrate

## PJ_1203A-v5.mjs

Similar to PJ_1203A-v4 with the following changes:
  - Updated so it works in the current Z2M version (2.6.0) and zigbee-herdsman-converters version (24.11.0)
  - Added optional singel-zero removal for current and power
      
## Home Assistant autodiscovery & Timestamps 

Home Assistant requires autodiscovery messages to configure the device entities. 
Z2M is supposed to take care of that automatically but unfortunately some important information are derived from the attribute name which is problematic for converters using 'non-standard' names. For example, the `device_class` is automatically set to `current` for attributes with name `current`, `current_phase_b` and `current_phase_c` but not for `current_a` and `current_b`. 

For non-standard attributes, the configuration cannot be done from the converter code. I recently filled a feature request to improve the situation  https://github.com/Koenkk/zigbee2mqtt/issues/22098 but for now, the configuration must be done manually either in zigbee2mqtt or in Homme Assistant.

My `zigbee2mqtt/data/configuration.yaml` contains the following entries for the PJ1203A device:

```
    homeassistant:
      power_a:
        device_class: power
        entity_category: diagnostic
        state_class: measurement
      power_b:
        device_class: power
        entity_category: diagnostic
        state_class: measurement
      power_ab:
        device_class: power
        entity_category: diagnostic
        state_class: measurement
      current_a:
        device_class: current
        entity_category: diagnostic
        state_class: measurement
        enabled_by_default: false
      current_b:
        device_class: current
        entity_category: diagnostic
        state_class: measurement
        enabled_by_default: false
      timestamp_a:
        icon: mdi:clock
        device_class: timestamp
        entity_category: diagnostic
        enabled_by_default: false
      timestamp_b:
        icon: mdi:clock
        device_class: timestamp
        entity_category: diagnostic
        enabled_by_default: false
```

The effects in HA are the following:
  - entities are assigned a proper icon. 
  - statistics are enabled in `power_a`, `power_b`,`power_ab`, `current_a` and `current_b` so they 
  can be displayed in statistics graphs. 
  - `timestamp_a` and `timestamp_b` are recognised as proper timestamp and will be 
  displayed as `XXX seconds ago` 
  

It should be noted that the default integration is correct for all energy
attributes because `Wh` and `kWh` unit are handled differently.

### References
  
  - MQTT Discovery documentation https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery
  - The HA integration in zigbee2mqtt https://github.com/Koenkk/zigbee2mqtt/blob/master/lib/extension/homeassistant.ts is a good reference.

## Known issues

My converters have to assume that the device is sending the datapoints in a specific 
order which may not always be true. 

The device probably supports OTA updates so a better firmware may exist somewhere.

Assuming that you have `jq` (https://jqlang.github.io/jq), the relevant information 
can be found in `database.db` with 


```
jq '. | select(.modelId=="TS0601") | {modelId,manufName,appVersion,stackVersion,hwVersion}'  database.db 
```

Otherwise, search `manufName`, `appVersion`, `stackVersion` and `hwVersion` for your TS0601 device.

Currently tested on:
  - `_TZE204_81yrt3lo` with appVersion 74, stackVersion 0 and hwVersion 1
  

### Huge Database in Home Assistant

By default, Home Assistant records all entity changes in its database for a duration of 10 days.

The following attributes of the PJ-1203A are updated every `update_frequency` seconds:
  - `power_a`, `power_b` and `power_ab`
  - `power_factor_a` and `power_factor_b`
  - `current_a` and `current_b`
  - `energy_flow_a` and `energy_flow_b`
  - `timestamp_a` and `timestamp_b` (or `update_a` and `update_b` )

So 10 days with an update frequency of let's say 5 seconds can produce up to `10*24*3600/5 = 172800` 
entries for each entity. Each entry occupies at least 300 bytes so an entity updated every 5s can 
increases the size of the database by up to 50MB.

The remaining attributes `ac_frequency`, `ac_voltage`, `energy_a`, `energy_b`, `energy_produced_a` and
`energy_produced_b` are modified far less frequently and are usually not a problem. 

The first step to prevent the database from growing too much is probably to
disable the entities you do not care about. That can be done by filtering them
out in `zigbee2mqtt` or by disabling them in Home Assistant.

The second step is to disable recording for some of the remaining entities in Home Assistant.
This is documented in https://www.home-assistant.io/integrations/recorder/

For example, I only need recording for the daily graphs of `power_a` and `power_b` so I use the following 
lines in my Home Assistant `configuration.yaml` file (restart needed):

```
recorder:
  exclude:
    entity_globs:
      - sensor.*_linkquality
    entities:
      - sensor.energy_meter_power_ab
      - sensor.energy_meter_timestamp_a
      - sensor.energy_meter_timestamp_b
      - sensor.energy_meter_current_a
      - sensor.energy_meter_current_b
      - sensor.energy_meter_energy_flow_a
      - sensor.energy_meter_energy_flow_b
      - sensor.energy_meter_power_factor_a
      - sensor.energy_meter_power_factor_b
```

Also, I am using the following sqlite3 query to count the number of entries per entity
in the HA database. The number should stop growing once recording is disabled.

```sh
#!/bin/sh

# Count the number of recordered entries per entity in the Home Assistant 
# database (sqlite3 only)

DATABASE="/share/Docker/HomeAssistant/config/home-assistant_v2.db"

sqlite3 "$DATABASE" 'SELECT COUNT(*), states_meta.entity_id  FROM states_meta, states where states_meta.metadata_id = states.metadata_id GROUP BY states_meta.entity_id ORDER BY COUNT(*) ;'  ".exit ;"

```

## Documentation

I could not find any official documentation and, in fact, I could not even identify the manufacturer of the `PJ-1203A`.

A table describing the datapoints was published in https://github.com/Koenkk/zigbee2mqtt/issues/18419 but its origin remains unclear. 


| #  | DP  | NAME                          | Report/Set     | Bytes | Comment                                                                                          | 
|----|-----|-------------------------------|----------------|-------|--------------------------------------------------------------------------------------------------|
| 1  | 115 | `DPID_POWER_TOTAL_ID`         | only report    | 4     | 1. report the total power (A+B) <br> 2. big-endian, 0.1W, X10 <br> 3. signed (32bits)            |
| 2  | 101 | `DPID_POWER_ID_A`             | only report    | 4     | 1. report the total power (A) <br> 2. big-endian, 0.1W, X10 <br> 3. unsigned int (32bits)        |
| 3  | 105 | `DPID_POWER_ID_B`             | only report    | 4     | 1. report the total power (B) <br> 2. big-endian, 0.1W, X10 <br> 3. unsigned int (32bits)        |
| 4  | 102 | `DPID_POWER_DIRECTION_ID_A`   | only report    | 1     | 0: Forward, 1:Reverse                                                                            |
| 5  | 104 | `DPID_POWER_DIRECTION_ID_B`   | only report    | 1     | 0: Forward, 1:Reverse                                                                            |
| 6  | 106 | `DPID_FORWARD_ENERGY_TOTAL_A` | only report    | 4     | 1. report the forward energy (A) <br> 2. big-endian, X100, 0.01KWH <br>3. unsigned int (32bits)  |
| 7  | 107 | `DPID_REVERSE_ENERGY_TOTAL_A` | only report    | 4     | 1. report the reverse energy (A) <br> 2. big-endian, X100, 0.01KWH <br>3. unsigned int (32bits)  |
| 8  | 108 | `DPID_FORWARD_ENERGY_TOTAL_B` | only report    | 4     | 1. report the forward energy (B) <br> 2. big-endian, X100, 0.01KWH <br> 3. unsigned int (32bits) |
| 9  | 109 | `DPID_REVERSE_ENERGY_TOTAL_B` | only report    | 4     | 1. report the reverse energy (B) <br> 2. big-endian, X100, 0.01KWH <br>3. unsigned int (32bits)  |
| 10 | 110 | `DPID_POWER_FACTOR_A`         | only report    | 4     | 1. report the power factor (A) <br> 2. big-endian, X100 <br> 3. unsigned int (32bits)            |
| 11 | 121 | `DPID_POWER_FACTOR_B`         | only report    | 4     | 1. report the power factor (B) <br> 2. big-endian, X100 <br> 3. unsigned int (32bits)            |
| 12 | 111 | `DPID_POWER_FREQ`             | only report    | 4     | 1. report the AC freq <br> 2. big-endian, X100 <br>3. unsigned int (32bits)                      |
| 13 | 112 | `DPID_VOLTAGE_A`              | only report    | 4     | 1. report the Voltage <br> 2. big-endian, X100<br> 3. unsigned int (32bits)                      |
| 14 | 113 | `DPID_CURRENT_A`              | only report    | 4     | 1. report the Current(A) <br> 2. big-endian, X100<br> 3. unsigned int (32bits)                   |
| 15 | 114 | `DPID_CURRENT_B`              | only report    | 4     | 1. report the Current(B) <br> 2. big-endian, X100 <br>3. unsigned int (32bits)                   |
| 16 | 129 | `DPID_UPDATE_RATE`            | report/setting | 4     | 1. report the update rate <br> 2. big-endian, (3-60s) <br>3. unsigned int (32bits)               |
| 17 | 116 | `DPID_VOLTAGE_A_COEF`         | report/setting | 4     | 1. Calibration Voltage <br> 2. big-endian, X1000 <br>3. unsigned int (32bits)                    |
| 18 | 117 | `DPID_CURRENT_A_COEF`         | report/setting | 4     | 1. Calibration Current_A <br> 2. big-endian, X1000 <br> 3. unsigned int (32bits)                 |
| 19 | 118 | `DPID_POWER_A_COEF`           | report/setting | 4     | 1. Calibration Power A <br> 2. big-endian, X1000 <br>3. unsigned int (32bits)                    |
| 20 | 119 | `DPID_ENERGY_A_COEF`          | report/setting | 4     | 1. Calibration Forward energy_A <br> 2. big-endian, X1000 <br> 3. unsigned int (32bits)          |
| 21 | 127 | `DPID_ENERGY_A_COEF_REV`      | report/setting | 4     | 1. Calibration Reverse energy_A <br> 2. big-endian, X1000 <br> 3. unsigned int (32bits)          |
| 22 | 122 | `DPID_FREQ_COEF`              | report/setting | 4     | 1. Calibration AC freq <br> 2. big-endian, X1000 <br> 3. unsigned int (32bits)                   |
| 23 | 123 | `DPID_CURRENT_B_COEF`         | report/setting | 4     | 1. Calibration Current_B <br> 2. big-endian, X1000 <br> 3. unsigned int (32bits)                 |
| 24 | 124 | `DPID_POWER_B_COEF`           | report/setting | 4     | 1. Calibration Power B <br> 2. big-endian, X1000 <br>3. unsigned int (32bits)                    |
| 25 | 125 | `DPID_ENERGY_B_COEF`          | report/setting | 4     | 1. Calibration Forward energy_B <br> 2. big-endian, X1000 <br> 3. unsigned int (32bits)          |
| 26 | 128 | `DPID_ENERGY_B_COEF_REV`      | report/setting | 4     | 1. Calibration Reverse energy_B <br> 2. big-endian, X1000 <br> 3. unsigned int (32bits)          |


The datapoint `106`, `107`, `108` and `109` are produced every 6 minutes. 

The datapoint `1` and `2` are also produced by the device and respectively contain  `DPID_FORWARD_ENERGY_TOTAL_A+DPID_FORWARD_ENERGY_TOTAL_B` (106+108) and 
`DPID_REVERSE_ENERGY_TOTAL_A+DPID_REVERSE_ENERGY_TOTAL_B` (107+109). 
  
The table describes all calibration datapoints as 'report/setting' but those are never reported. An explicit query may be necessary. 
QUESTION: IS THERE A STANDARD METHOD TO QUERY A TUYA DATAPOINT? 

QUESTION: There are no datapoints for 103, 120 and 126. Some undocumented settings maybe? Maybe to control the update rate for dp 106-109?

QUESTION: Why use VOLTAGE_A for the dp 112 and 116? Is there a `VOLTAGE_B`? 

## Calibration datapoints

** THEY ARE CURRENTLY COMMENTED IN THE CODE BECAUSE THEIR BEHAVIOR IS PURELY COSMETIC ** 

The calibration datapoints (entries 17 to 26 in table) are all specified with a X1000 multiplier and an unsigned int value. 

After a few experiments on `DPID_FREQ_COEF` (an easy one since it is pretty much constant), it appears that the calibration is 
a multiplier scaled by 1/1000. For example, 730 causes a multiplication by 0.73 and 1000 (x1.0) does nothing. 

This is not indicated in the table but values below 500 and above 2000 are ignored so the usable calibration range is 0.5 to 2.0.

Consequently, the following expose options are working quite well with a `.divideBy1000` filter on all datapoint converters: 

```.withValueMin(0.5).withValueMax(2.0).withValueStep(0.01).withPreset('default',1.0,'Default value')```

The device reacts to a successfull change by emiting the datapoint and it remains silent otherwise. There is 
currently no known method to obtain the current value of a calibration. 

Also, those calibrations do not affect each others. For example, Voltage, Power and Current should be related
by the formula Power=Voltage*Current but applying a calibration on one does not affect the other two.
         
Simply speaking, the calibrations are purely cosmetic.

**TODO**: Check if the accumulated energies (in kWh) are affected by the power
calibrations (in W). That would be the only sensible use for the calibration.

**WARNING**: The energy calibration are applied to the TOTAL value accumulated so far. 
For example, if `energy_a` is currently reporting 20000 kWh of accumulated
and `calibration_energy_a` is set to 1.3 then the next report is going to
be 26000 kWh. Home Assistant will interpret that as a +6000kWh of instantaneous
energy consumption.

Simply speaking, **CHANGING AN ENERGY CALIBRATION IS PROBABLY A BAD IDEA.**










