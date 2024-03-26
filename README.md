# z2m_PJ-1203A
A small repository for my custom zigbee2mqtt converter for the PJ-1203A


## Installation

Assuming that zigbee2mqtt is installed in `/opt/zigbee2mqtt`, copy the file `PJ-1203A.js` in thedirectory `/opt/zigbee2mqtt/data`. 
 
The external converter also need to be declared in `/opt/zigbee2mqtt/configuration.yaml`
   
Be aware that `zigbee2mqtt` will fallback to the builtin `PJ-1203A` converter if the external one cannot be loaded.
Syntax errors in the converters can be detected before starting zigbee2mqtt with 

    node /opt/zigbee2mqtt/data/PJ-1203A.js
    
but that only works for files that are located inside the `/opt/zigbee2mqtt` directory.

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

## New features

The default behavior should be pretty much identical to the default converter but some options
are provided to enable the new features. 

Please refer to the options descriptions and to the code for more details. 

I will not describe everything here because this is likely to change quite often.

The new (optional) features are:
  - publish `energy_flow_x`, `power_x`, `current_x` and `power_factor_x` together at the end of each update 
    or during the next update after receiving `energy_flow_x`. 
  - make sure that no zigbee messages were missing or reordered while collecting `energy_flow_x`, 
    `power_x`, `current_x` and `power_factor_x`.
  - customizable behaviour when some of `energy_flow_x`, `power_x`, `current_x` and `power_factor_x` are missing.
  - recompute `power_ab` when needed.
  - add `counter_a` and `counter_b` to keep track of updates on each channel. 

## Known issues

### It was only tested on my `_TZE204_81yrt3lo`

There is also a `_TZE200_rks0sgb7` variant that may or may not have the same issues. 

More generally, my converter has to assume that the device is sending the datapoints 
in a specific order. 

Also, the device probably supports OTA updates so a better firmware may exist somewhere.

More information are needed. 

