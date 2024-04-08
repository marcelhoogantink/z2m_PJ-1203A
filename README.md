# z2m_PJ-1203A
A small repository for my custom zigbee2mqtt converter for the PJ-1203A

I started a discussion in https://github.com/Koenkk/zigbee2mqtt/discussions/21956

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

My main concern with the current `PJ-1203A` converter was what should probably called a bug in the device. For channel x, the 4 attributes `energy_flow_x`, `current_x`, `power_x` and `power_factor_x` are regularly provided in that order. This is a bi-directional sensor so `energy_flow_x` describes the direction of the current and can be either `consuming` or `producing`. Unfortunately, that attribute is not properly synchronized with the other three. In practice, that means that zigbee2mqtt reports a incorrect energy flow during a few seconds when swtiching  between `consuming` and `producing`.

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
  - a single option to delay the publication until the next update (see above).
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

Similar to PJ_1203A-v2 with the followwing changes:
  - An option to control how the energy flow direction should be reported:  
     consuming/producing in `energy_flow_x` or signed `power_x` (and `energy_flow_x`
     is set to 'sign')
  - Separate options for channels A and B (where applicable).
  - `update_a` and `update_b` are replaced by `timestamp_a` and `timestamp_b`
    whose value indicates when the power datapoint was received in ISO_8601 format.
    That makes them valid timestamps in Home Assistant (see below).
    
## Home Assistant autodiscovery & Timestamps 

Home Assistant requires autodiscovery messages to configure the device entities. 
Z2M is supposed to take care of that automatically but unfortunately some important information are derived from the attribute name which is problematic for converters using 'non-standard' names. For example, the `device_class` is automatically set to `current` for attributes with name `current`, `current_phase_b` and `current_phase_c` but not for `current_a` and `current_b`. 

For non-stanard attributes, the configuration cannot be done from the converter code. I recently filled a feature request to improve the situation  https://github.com/Koenkk/zigbee2mqtt/issues/22098 but for now, the configuration must be done manually either in zigbee2mqtt or in Homme Assistant.

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
  - statistics are enabled in `power_a`, `power_b`,`power_ab`, `current_a` and `current_b` so they can be displayed in statistics graphs. 
  - `timestamp_a` and `timestamp_b` are recognised as proper timestamp and will be displayed as `XXX seconds ago` 
  

It should be noted that the default integration is correct for all energy attributes since usint `Wh` and `kWh` are handled differently. 

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
entries for each entity.

The remianing attributes `ac_frequency`, `ac_voltage`, `energy_a`, `energy_b`, `energy_produced_a` and
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

Also, I am using the following shell script to count the number of entries in the HA database.
They should stop growing once the recording is disabled.

```sh
#!/bin/sh

# Count the number of recordered entries per entity in the Home Assistant 
# database (sqlite3 only)

DATABASE="/share/Docker/HomeAssistant/config/home-assistant_v2.db"

sqlite3 "$DATABASE" 'SELECT COUNT(*), states_meta.entity_id  FROM states_meta, states where states_meta.metadata_id = states
.metadata_id GROUP BY states_meta.entity_id ORDER BY COUNT(*) ;'  ".exit ;"

```

